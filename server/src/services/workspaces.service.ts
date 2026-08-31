import { createHash, randomBytes } from 'node:crypto';
import { AppError, ERROR_CODES, conflict, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { prisma, type TransactionClient } from '../lib/prisma.js';
import { publicUser, publicUserSelect, serialize } from '../lib/serialize.js';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { colorFromString, slugify, uniqueSlug } from '../utils/slug.js';
import { authorize, canManageTargetRole, isWorkspaceManager } from '../lib/permissions.js';
import type { CreateWorkspaceInput, InviteMemberInput, UpdateWorkspaceInput } from '../validators/workspace.schema.js';
import { activityService } from './activity.service.js';
import { notificationsService } from './notifications.service.js';
import { presenceService } from './presence.service.js';
import { realtime } from './realtime.service.js';
import type { WorkspaceRole } from '../generated/prisma/enums.js';
import { DEFAULT_CHANNELS } from './channels.service.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AuthedWorkspace {
  id: string;
  name: string;
  slug: string;
  role: WorkspaceRole;
  accentColor: string;
  description: string | null;
  memberCount: number;
  projectCount: number;
  createdAt: Date;
}

const membershipInclude = {
  user: { select: publicUserSelect },
} as const;

export const workspacesService = {
  /** Workspace + role fragment returned after login — cheap and cache-friendly. */
  async listForUser(userId: string): Promise<AuthedWorkspace[]> {
    const rows = await prisma.workspaceMember.findMany({
      where: { userId },
      orderBy: [{ joinedAt: 'asc' }],
      include: { workspace: { select: { id: true, name: true, slug: true, accentColor: true, description: true, createdAt: true, _count: { select: { members: true, projects: true } } } } },
    });
    return rows
      .filter(row => row.workspace !== null)
      .map(row => ({
        id: row.workspace!.id,
        name: row.workspace!.name,
        slug: row.workspace!.slug,
        role: row.role,
        accentColor: row.workspace!.accentColor,
        description: row.workspace!.description,
        memberCount: row.workspace!._count.members,
        projectCount: row.workspace!._count.projects,
        createdAt: row.workspace!.createdAt,
      }));
  },

  async summary(userId: string, workspaceId: string) {
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      include: {
        workspace: {
          select: {
            id: true,
            name: true,
            slug: true,
            description: true,
            accentColor: true,
            createdAt: true,
            _count: { select: { members: true, projects: true } },
          },
        },
      },
    });
    if (!membership || !membership.workspace) throw notFound('Workspace not found', ERROR_CODES.WORKSPACE_NOT_FOUND);
    return serialize({
      id: membership.workspace.id,
      name: membership.workspace.name,
      slug: membership.workspace.slug,
      description: membership.workspace.description,
      accentColor: membership.workspace.accentColor,
      role: membership.role,
      memberCount: membership.workspace._count.members,
      projectCount: membership.workspace._count.projects,
      createdAt: membership.workspace.createdAt,
    });
  },

  /**
   * Verifies membership and returns the workspace. Every workspace-scoped
   * request funnels through here (IDOR guard for `/api/workspaces/:id/...`).
   */
  async assertMembership(
    userId: string,
    workspaceId: string,
    tx: TransactionClient = prisma,
  ): Promise<{ workspaceId: string; role: WorkspaceRole }> {
    const membership = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true, workspaceId: true },
    });
    if (!membership) throw new AppError(ERROR_CODES.NOT_A_MEMBER, 'You are not a member of this workspace', 403);
    return { workspaceId, role: membership.role };
  },

  /** Membership + workspace identity in one query (used by project guards). */
  async resolveAccess(userId: string, workspaceId: string, tx: TransactionClient = prisma) {
    const membership = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true, workspace: { select: { id: true, name: true } } },
    });
    if (!membership) throw new AppError(ERROR_CODES.NOT_A_MEMBER, 'You are not a member of this workspace', 403);
    return { workspaceId, role: membership.role, workspace: membership.workspace ?? { id: workspaceId, name: 'Workspace' } };
  },

  async get(userId: string, workspaceId: string) {
    await this.assertMembership(userId, workspaceId);
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        accentColor: true,
        createdAt: true,
        updatedAt: true,
        creator: { select: publicUserSelect },
        _count: { select: { projects: true, members: true } },
      },
    });
    if (!workspace) throw notFound('Workspace not found', ERROR_CODES.WORKSPACE_NOT_FOUND);
    return serialize({ ...workspace, creator: workspace.creator ? publicUser(workspace.creator) : null });
  },

  async create(userId: string, input: CreateWorkspaceInput) {
    const created = await prisma.$transaction(tx => this.createInTransaction(tx, { userId, ...input }));
    await activityService.record({
      workspaceId: created.id,
      actorId: userId,
      type: 'WORKSPACE_CREATED',
      summary: 'Workspace created',
    });
    await this.ensureDefaultChannels(created.id);
    logger.info('workspace created', { workspaceId: created.id, userId });
    return this.summary(userId, created.id);
  },

  /** Reusable inside larger transactions (e.g. user registration). */
  async createInTransaction(
    tx: TransactionClient,
    input: { userId: string; name: string; description?: string | null; accentColor?: string },
  ) {
    const baseSlug = slugify(input.name);
    const slug = await uniqueSlug(baseSlug, async candidate => {
      const hit = await tx.workspace.findUnique({ where: { slug: candidate }, select: { id: true } });
      return hit !== null;
    });
    const workspace = await tx.workspace.create({
      data: {
        name: input.name,
        slug,
        description: input.description ?? null,
        accentColor: input.accentColor ?? colorFromString(slug),
        creatorId: input.userId,
        members: { create: { userId: input.userId, role: 'OWNER' } },
      },
      select: { id: true, name: true, slug: true },
    });
    return workspace;
  },

  /** Every workspace starts with the same channel set so chat is never empty. */
  async ensureDefaultChannels(workspaceId: string, projectIds: string[] = []) {
    const existing = await prisma.channel.findMany({ where: { workspaceId }, select: { name: true } });
    const have = new Set(existing.map(c => c.name));
    const toCreate = DEFAULT_CHANNELS.filter(name => !have.has(name));
    if (toCreate.length) {
      await prisma.channel.createMany({ data: toCreate.map(name => ({ workspaceId, name, type: 'GENERAL' })), skipDuplicates: true });
    }
    for (const projectId of projectIds) {
      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, key: true } });
      if (!project) continue;
      const name = project.key.toLowerCase();
      const found = await prisma.channel.findFirst({ where: { workspaceId, projectId } });
      if (!found) {
        await prisma.channel.create({ data: { workspaceId, projectId, name, type: 'PROJECT' } }).catch(() => undefined);
      }
    }
    return true;
  },

  async update(userId: string, workspaceId: string, input: UpdateWorkspaceInput) {
    const { role } = await this.assertMembership(userId, workspaceId);
    authorize(role, 'workspace:update', { message: 'Only owners and admins can edit workspace settings' });

    await prisma.$transaction(async tx => {
      const data: Record<string, unknown> = {};
      if (input.name !== undefined) {
        data.name = input.name;
        data.slug = await uniqueSlug(slugify(input.name), async candidate => {
          const hit = await tx.workspace.findUnique({ where: { slug: candidate }, select: { id: true } });
          return hit !== null;
        });
      }
      if (input.description !== undefined) data.description = input.description;
      if (input.accentColor) data.accentColor = input.accentColor;
      await tx.workspace.update({ where: { id: workspaceId }, data: data as never });
      await activityService.recordInTransaction(tx, {
        workspaceId,
        actorId: userId,
        type: 'WORKSPACE_UPDATED',
        summary: 'Workspace settings updated',
      });
    });

    const summary = await this.summary(userId, workspaceId);
    realtime.toWorkspace(workspaceId, 'workspace:updated', { workspace: summary });
    return summary;
  },

  async delete(userId: string, workspaceId: string) {
    const { role } = await this.assertMembership(userId, workspaceId);
    authorize(role, 'workspace:delete', { message: 'Only the workspace owner can delete a workspace' });
    const projectCount = await prisma.project.count({ where: { workspaceId } });
    await prisma.workspace.delete({ where: { id: workspaceId } });
    logger.warn('workspace deleted', { workspaceId, userId, projectCount });
    return { id: workspaceId, deletedProjects: projectCount };
  },

  async listMembers(userId: string, workspaceId: string) {
    await this.assertMembership(userId, workspaceId);
    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId },
      orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
      include: { user: { select: publicUserSelect }, invitedBy: { select: { id: true, name: true } } },
    });
    const online = new Set(presenceService.onlineUserIds());
    return serialize(
      members.map(member => ({
        id: member.id,
        role: member.role,
        joinedAt: member.joinedAt,
        invitedBy: member.invitedBy ?? null,
        user: { ...publicUser(member.user), presence: online.has(member.user.id) ? ('online' as const) : ('offline' as const) },
      })),
    );
  },

  async removeMember(userId: string, workspaceId: string, memberId: string) {
    const { role } = await this.assertMembership(userId, workspaceId);
    authorize(role, 'member:remove', { message: 'Only owners and admins can remove members' });

    const target = await prisma.workspaceMember.findUnique({ where: { id: memberId }, include: { user: { select: { id: true, name: true } } } });
    if (!target || target.workspaceId !== workspaceId) throw notFound('Member not found');

    const isSelf = target.userId === userId;
    if (!isSelf) authorize(role, 'member:remove');
    if (!canManageTargetRole(role, target.role, isSelf)) {
      throw forbidden(`You cannot remove a ${target.role} from this workspace`);
    }
    if (target.role === 'OWNER') {
      const owners = await prisma.workspaceMember.count({ where: { workspaceId, role: 'OWNER' } });
      if (owners <= 1) throw new AppError(ERROR_CODES.LAST_OWNER, 'A workspace must keep an owner — transfer ownership first', 409);
    }

    const removed = await prisma.$transaction(async tx => {
      await tx.workspaceMember.delete({ where: { id: memberId } });
      // Projects that only this person could see must not silently keep them.
      await tx.projectMember.deleteMany({ where: { userId: target.userId, project: { workspaceId } } });
      await activityService.recordInTransaction(tx, {
        workspaceId,
        actorId: userId,
        type: 'MEMBER_REMOVED',
        summary: isSelf ? `${target.user.name} left the workspace` : `${target.user.name} was removed from the workspace`,
      });
      return { id: memberId, userId: target.userId };
    });

    realtime.toWorkspace(workspaceId, 'member:removed', { workspaceId, memberId });
    logger.info('workspace member removed', { workspaceId, memberId, by: userId, self: isSelf });
    return removed;
  },

  async updateRole(userId: string, workspaceId: string, memberId: string, role: WorkspaceRole) {
    const { role: actorRole } = await this.assertMembership(userId, workspaceId);
    authorize(actorRole, 'member:changeRole', { message: 'Only owners and admins can change roles' });

    const target = await prisma.workspaceMember.findUnique({ where: { id: memberId }, select: { id: true, userId: true, role: true, workspaceId: true } });
    if (!target || target.workspaceId !== workspaceId) throw notFound('Member not found');
    if (target.role === 'OWNER' || role === 'OWNER') {
      throw new AppError(ERROR_CODES.LAST_OWNER, 'Ownership must be transferred explicitly, not by editing a role', 409);
    }
    if (!canManageTargetRole(actorRole, target.role, target.userId === userId)) {
      throw forbidden(`You cannot change the role of a ${target.role}`);
    }

    await prisma.$transaction(async tx => {
      await tx.workspaceMember.update({ where: { id: memberId }, data: { role } });
      await activityService.recordInTransaction(tx, {
        workspaceId,
        actorId: userId,
        type: 'ROLE_CHANGED',
        summary: `${isWorkspaceManager(role) ? 'Promoted' : 'Changed'} workspace role to ${role}`,
        metadata: { memberId, from: target.role, to: role },
      });
    });

    await notificationsService.create({
      recipientId: target.userId,
      workspaceId,
      type: 'WORKSPACE_ROLE_CHANGED',
      title: 'Your workspace role changed',
      body: `You are now ${role} in this workspace.`,
      actorId: userId,
      link: `/app/workspaces/${workspaceId}/team`,
    });
    realtime.toWorkspace(workspaceId, 'role:changed', { workspaceId, memberId, role });
    return { id: memberId, role };
  },

  async transferOwnership(userId: string, workspaceId: string, newOwnerMemberId: string) {
    const { role } = await this.assertMembership(userId, workspaceId);
    authorize(role, 'workspace:transfer', { message: 'Only the owner can transfer ownership' });
    const target = await prisma.workspaceMember.findUnique({ where: { id: newOwnerMemberId }, include: { user: { select: { id: true, name: true } } } });
    if (!target || target.workspaceId !== workspaceId) throw notFound('Member not found');

    await prisma.$transaction(async tx => {
      const current = await tx.workspaceMember.findFirst({ where: { workspaceId, role: 'OWNER' }, select: { id: true, userId: true } });
      if (!current) throw notFound('Workspace owner not found');
      await tx.workspaceMember.update({ where: { id: current.id }, data: { role: 'ADMIN' } });
      await tx.workspaceMember.update({ where: { id: target.id }, data: { role: 'OWNER' } });
      await tx.workspace.update({ where: { id: workspaceId }, data: { creatorId: target.userId } });
      await activityService.recordInTransaction(tx, {
        workspaceId,
        actorId: userId,
        type: 'ROLE_CHANGED',
        summary: `Ownership transferred to ${target.user.name}`,
        metadata: { fromUserId: current.userId, toUserId: target.userId },
      });
    });

    await notificationsService.create({
      recipientId: target.userId,
      workspaceId,
      type: 'WORKSPACE_ROLE_CHANGED',
      title: 'You are the new workspace owner',
      body: 'Ownership was transferred to you.',
      actorId: userId,
      link: `/app/workspaces/${workspaceId}/team`,
    });
    return { workspaceId, ownerId: target.userId };
  },

  /* ─────────────────────────────── invitations ─────────────────────────────── */

  async inviteMember(userId: string, workspaceId: string, input: InviteMemberInput) {
    const { role } = await this.assertMembership(userId, workspaceId);
    authorize(role, 'member:invite', { message: 'Only owners and admins can invite people' });

    const email = input.email.toLowerCase();
    const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true, name: true } });
    if (existingUser) {
      const member = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: existingUser.id } },
        select: { id: true },
      });
      if (member) throw conflict(`${existingUser.name} is already a member of this workspace`);
    }

    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    const invitation = await prisma.$transaction(async tx => {
      await tx.workspaceInvitation.deleteMany({ where: { workspaceId, email, acceptedAt: null, expiresAt: { lt: new Date() } } });
      const created = await tx.workspaceInvitation.upsert({
        where: { workspaceId_email: { workspaceId, email } },
        update: { tokenHash, role: input.role, message: input.message ?? null, expiresAt, acceptedAt: null, invitedById: userId },
        create: { workspaceId, email, role: input.role, tokenHash, message: input.message ?? null, expiresAt, invitedById: userId },
        select: { id: true, email: true, role: true, message: true, expiresAt: true, createdAt: true },
      });
      await activityService.recordInTransaction(tx, {
        workspaceId,
        actorId: userId,
        type: 'INVITATION_CREATED',
        summary: `Invited ${email} as ${input.role}`,
        metadata: { email, role: input.role },
      });
      return created;
    });

    const inviteUrl = `${config.clientUrl}/invite?token=${rawToken}`;
    logger.info('invitation created', { workspaceId, email, by: userId });

    // If the person already has an account, notify them in-app too.
    if (existingUser) {
      await notificationsService.create({
        recipientId: existingUser.id,
        workspaceId,
        type: 'WORKSPACE_INVITED',
        title: 'You were invited to a workspace',
        body: 'Open the invitation link to join.',
        actorId: userId,
        link: inviteUrl,
      });
    }

    return serialize({
      ...invitation,
      // The plaintext token only ever exists in this response (dev convenience:
      // no mail provider is configured, so the UI shows the join link directly).
      inviteUrl: config.isProduction ? null : inviteUrl,
      existingUser: existingUser ? { id: existingUser.id, name: existingUser.name } : null,
    });
  },

  async listInvitations(userId: string, workspaceId: string) {
    const { role } = await this.assertMembership(userId, workspaceId);
    if (!isWorkspaceManager(role)) throw forbidden('Only owners and admins can view invitations');
    const items = await prisma.workspaceInvitation.findMany({
      where: { workspaceId, acceptedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      include: { invitedBy: { select: publicUserSelect } },
    });
    return serialize(items.map(item => ({ ...item, invitedBy: item.invitedBy ? serialize(publicUser(item.invitedBy)) : null })));
  },

  async revokeInvitation(userId: string, workspaceId: string, invitationId: string) {
    const { role } = await this.assertMembership(userId, workspaceId);
    authorize(role, 'member:invite');
    const result = await prisma.workspaceInvitation.deleteMany({ where: { id: invitationId, workspaceId } });
    if (result.count === 0) throw notFound('Invitation not found');
    return { id: invitationId };
  },

  /** Public (unauthenticated) preview of what an invite token points at. */
  async previewInvitation(rawToken: string) {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const invitation = await prisma.workspaceInvitation.findUnique({
      where: { tokenHash },
      include: {
        workspace: { select: { id: true, name: true, slug: true, accentColor: true, _count: { select: { members: true } } } },
        invitedBy: { select: publicUserSelect },
      },
    });
    if (!invitation) throw unauthorized('This invitation link is invalid', 'INVALID_INVITE');
    if (invitation.acceptedAt) throw conflict('This invitation was already used');
    if (invitation.expiresAt.getTime() < Date.now()) throw unauthorized('This invitation has expired', 'INVITE_EXPIRED');
    return serialize({
      email: invitation.email,
      role: invitation.role,
      message: invitation.message,
      expiresAt: invitation.expiresAt,
      workspace: { ...invitation.workspace, memberCount: invitation.workspace._count.members },
      invitedBy: invitation.invitedBy ? publicUser(invitation.invitedBy) : null,
    });
  },

  async acceptInvitation(userId: string, rawToken: string) {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const invitation = await prisma.workspaceInvitation.findUnique({ where: { tokenHash } });
    if (!invitation) throw unauthorized('This invitation link is invalid', 'INVALID_INVITE');
    if (invitation.acceptedAt) throw conflict('This invitation was already used');
    if (invitation.expiresAt.getTime() < Date.now()) throw unauthorized('This invitation has expired', 'INVITE_EXPIRED');

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, email: true, name: true } });
    // Defence in depth: an invite for someone@x.test may only be redeemed by
    // that address (or by the account that was created for it).
    if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw forbidden(`This invitation was sent to ${invitation.email}. Sign in with that account to accept it.`);
    }

    const workspace = await prisma.$transaction(async tx => {
      const existing = await tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId } },
        select: { id: true },
      });
      if (!existing) {
        await tx.workspaceMember.create({ data: { workspaceId: invitation.workspaceId, userId, role: invitation.role, invitedById: invitation.invitedById } });
        await activityService.recordInTransaction(tx, {
          workspaceId: invitation.workspaceId,
          actorId: userId,
          type: 'MEMBER_ADDED',
          summary: `${user.name} joined the workspace`,
        });
      }
      await tx.workspaceInvitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } });
      await this.ensureDefaultChannels(invitation.workspaceId);
      const updated = await tx.workspace.findUniqueOrThrow({
        where: { id: invitation.workspaceId },
        select: { id: true, name: true, slug: true, accentColor: true, description: true, createdAt: true, _count: { select: { members: true, projects: true } } },
      });
      return updated;
    });

    realtime.toWorkspace(invitation.workspaceId, 'member:joined', { workspaceId: invitation.workspaceId, memberName: user.name });
    logger.info('invitation accepted', { workspaceId: invitation.workspaceId, userId });

    return serialize({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      role: invitation.role,
      accentColor: workspace.accentColor,
      description: workspace.description,
      memberCount: workspace._count.members,
      projectCount: workspace._count.projects,
      createdAt: workspace.createdAt,
    });
  },

  /** Leaves a workspace as a non-owner (owner must transfer or delete). */
  async leaveWorkspace(userId: string, workspaceId: string) {
    const membership = await this.assertMembership(userId, workspaceId);
    if (membership.role === 'OWNER') {
      const owners = await prisma.workspaceMember.count({ where: { workspaceId, role: 'OWNER' } });
      if (owners <= 1) throw new AppError(ERROR_CODES.LAST_OWNER, 'Transfer ownership before leaving the workspace', 409);
    }
    await prisma.$transaction(async tx => {
      await tx.workspaceMember.deleteMany({ where: { workspaceId, userId } });
      await tx.projectMember.deleteMany({ where: { userId, project: { workspaceId } } });
      const user = await tx.user.findUnique({ where: { id: userId }, select: { name: true } });
      await activityService.recordInTransaction(tx, {
        workspaceId,
        actorId: userId,
        type: 'MEMBER_REMOVED',
        summary: `${user?.name ?? 'A member'} left the workspace`,
      });
    });
    realtime.toWorkspace(workspaceId, 'member:removed', { workspaceId, memberId: null, userId });
    return { workspaceId };
  },
};
