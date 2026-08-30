import { AppError, ERROR_CODES, conflict, forbidden, notFound } from '../lib/errors.js';
import { prisma, type TransactionClient } from '../lib/prisma.js';
import { publicUser, publicUserSelect, serialize } from '../lib/serialize.js';
import { authorize, can } from '../lib/permissions.js';
import type { ProjectStatus, WorkspaceRole } from '../generated/prisma/enums.js';
import { activityService } from './activity.service.js';
import { notificationsService } from './notifications.service.js';
import { realtime } from './realtime.service.js';
import { workspacesService } from './workspaces.service.js';
import { logger } from '../config/logger.js';
import type { CreateProjectInput, ProjectListQueryInput, UpdateProjectInput } from '../validators/project.schema.js';
import { channelsService } from './channels.service.js';
import type { ProjectProgress, TaskStatus } from '@teamflow/shared';

const EMPTY_PROGRESS: ProjectProgress = {
  total: 0,
  completed: 0,
  percent: 0,
  byStatus: { TODO: 0, IN_PROGRESS: 0, REVIEW: 0, DONE: 0 },
};

/**
 * Aggregates task counters for many projects in ONE grouped query instead of
 * a count-per-project round trip (no N+1).
 */
async function progressForProjects(projectIds: string[]) {
  if (projectIds.length === 0) return new Map<string, { progress: ProjectProgress; overdue: number }>();
  const [grouped, overdue] = await Promise.all([
    prisma.task.groupBy({
      by: ['projectId', 'status'],
      where: { projectId: { in: projectIds } },
      _count: { _all: true },
    }),
    prisma.task.groupBy({
      by: ['projectId'],
      where: { projectId: { in: projectIds }, status: { not: 'DONE' }, dueDate: { lt: new Date() } },
      _count: { _all: true },
    }),
  ]);

  const map = new Map<string, { progress: ProjectProgress; overdue: number }>();
  for (const projectId of projectIds) map.set(projectId, { progress: structuredClone(EMPTY_PROGRESS), overdue: 0 });
  for (const row of grouped) {
    const entry = map.get(row.projectId);
    if (!entry) continue;
    const count = row._count._all;
    entry.progress.byStatus[row.status as TaskStatus] = count;
    entry.progress.total += count;
    if (row.status === 'DONE') entry.progress.completed += count;
  }
  for (const entry of map.values()) {
    entry.progress.percent = entry.progress.total === 0 ? 0 : Math.round((entry.progress.completed / entry.progress.total) * 100);
  }
  for (const row of overdue) {
    const entry = map.get(row.projectId);
    if (entry) entry.overdue = row._count._all;
  }
  return map;
}

export const projectsService = {
  emptyProgress: EMPTY_PROGRESS,

  async list(userId: string, workspaceId: string, query: ProjectListQueryInput) {
    const { role } = await workspacesService.assertMembership(userId, workspaceId);
    const includeArchived = query.includeArchived ?? query.status === 'ARCHIVED';

    const and: Record<string, unknown>[] = [];
    if (query.search) {
      and.push({
        OR: [
          { name: { contains: query.search, mode: 'insensitive' as const } },
          { key: { contains: query.search.toUpperCase(), mode: 'insensitive' as const } },
          { description: { contains: query.search, mode: 'insensitive' as const } },
        ],
      });
    }
    // Members only see projects they joined unless they manage the workspace.
    if (!can(role, 'project:update')) and.push({ OR: [{ members: { some: { userId } } }, { createdById: userId }] });

    const where = {
      workspaceId,
      ...(includeArchived ? {} : { archivedAt: null }),
      ...(query.status ? { status: query.status } : {}),
      ...(and.length ? { AND: and } : {}),
    };

    const orderBy =
      query.sort === 'name'
        ? [{ name: 'asc' as const }]
        : query.sort === 'dueDate'
          ? [{ dueDate: { sort: 'asc' as const, nulls: 'last' as const } }]
          : [{ updatedAt: 'desc' as const }];

    const [rows, total] = await Promise.all([
      prisma.project.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          workspaceId: true,
          key: true,
          name: true,
          description: true,
          status: true,
          color: true,
          startDate: true,
          dueDate: true,
          archivedAt: true,
          createdAt: true,
          updatedAt: true,
          createdBy: { select: publicUserSelect },
          _count: { select: { members: true, tasks: true } },
        },
      }),
      prisma.project.count({ where }),
    ]);

    const progressMap = await progressForProjects(rows.map(r => r.id));
    const memberships = rows.length
      ? await prisma.projectMember.findMany({
          where: { projectId: { in: rows.map(r => r.id) }, userId },
          select: { projectId: true },
        })
      : [];
    const mine = new Set(memberships.map(m => m.projectId));

    return {
      items: serialize(
        rows.map(row => ({
          ...row,
          createdBy: row.createdBy ? publicUser(row.createdBy) : null,
          memberCount: row._count.members,
          taskCount: row._count.tasks,
          progress: progressMap.get(row.id)?.progress ?? EMPTY_PROGRESS,
          overdueCount: progressMap.get(row.id)?.overdue ?? 0,
          myRole: role,
          isMember: mine.has(row.id) || can(role, 'project:update'),
        })),
      ),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
        hasNextPage: query.page * query.pageSize < total,
      },
    };
  },

  async get(userId: string, projectId: string) {
    const { workspace } = await this.assertAccess(userId, projectId);
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      include: {
        createdBy: { select: publicUserSelect },
        members: { include: { user: { select: publicUserSelect } }, orderBy: { createdAt: 'asc' } },
        _count: { select: { tasks: true } },
      },
    });
    const progressMap = await progressForProjects([project.id]);
    return serialize({
      id: project.id,
      workspaceId: project.workspaceId,
      key: project.key,
      name: project.name,
      description: project.description,
      status: project.status,
      color: project.color,
      startDate: project.startDate,
      dueDate: project.dueDate,
      archivedAt: project.archivedAt,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      createdBy: project.createdBy ? publicUser(project.createdBy) : null,
      taskCount: project._count.tasks,
      memberCount: project.members.length,
      progress: progressMap.get(project.id)?.progress ?? EMPTY_PROGRESS,
      overdueCount: progressMap.get(project.id)?.overdue ?? 0,
      myRole: workspace.role,
      workspaceName: workspace.name,
      members: project.members.map(member => ({
        id: member.id,
        role: workspace.role,
        joinedAt: member.createdAt,
        user: publicUser(member.user),
      })),
    });
  },

  /**
   * Authorisation core for `/api/projects/:projectId*`:
   * loads the project, verifies workspace membership + project access.
   */
  async assertAccess(
    userId: string,
    projectId: string,
    tx: TransactionClient = prisma,
  ): Promise<{
    projectId: string;
    workspaceId: string;
    role: WorkspaceRole;
    project: { id: string; workspaceId: string; key: string; name: string; color: string; status: ProjectStatus; archivedAt: Date | null; createdById: string };
    workspace: { id: string; name: string; role: WorkspaceRole };
  }> {
    const project = await tx.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        workspaceId: true,
        key: true,
        name: true,
        color: true,
        status: true,
        archivedAt: true,
        createdById: true,
        workspace: { select: { id: true, name: true } },
      },
    });
    if (!project) throw notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);
    const access = await workspacesService.resolveAccess(userId, project.workspaceId, tx);
    const isMember = await tx.projectMember.findUnique({
      where: { projectId_userId: { projectId: project.id, userId } },
      select: { id: true },
    });
    const manager = can(access.role, 'project:update');
    if (!isMember && !manager && project.createdById !== userId) {
      // Non-member, non-manager: treat private projects as not visible.
      throw forbidden('You do not have access to this project', 'PROJECT_ACCESS_DENIED');
    }
    return {
      projectId: project.id,
      workspaceId: project.workspaceId,
      role: access.role,
      project,
      workspace: { id: project.workspaceId, name: access.workspace.name, role: access.role },
    };
  },

  async create(userId: string, workspaceId: string, input: CreateProjectInput) {
    const { role } = await workspacesService.assertMembership(userId, workspaceId);
    authorize(role, 'project:create', { message: 'Only owners and admins can create projects' });

    const project = await prisma.$transaction(async tx => {
      const duplicate = await tx.project.findFirst({ where: { workspaceId, key: input.key }, select: { id: true } });
      if (duplicate) throw conflict(`Project key ${input.key} is already used in this workspace`, 'PROJECT_KEY_TAKEN');
      const created = await tx.project.create({
        data: {
          workspaceId,
          key: input.key,
          name: input.name,
          description: input.description ?? null,
          status: (input.status ?? 'PLANNING') as ProjectStatus,
          color: input.color ?? 'indigo',
          startDate: (input.startDate as Date | null | undefined) ?? null,
          dueDate: (input.dueDate as Date | null | undefined) ?? null,
          createdById: userId,
          members: {
            create: [...new Set([userId, ...(input.memberIds ?? [])])].map(memberId => ({ userId: memberId })),
          },
        },
        select: { id: true, key: true, name: true },
      });
      await channelsService.ensureProjectChannel(tx, workspaceId, created.id, created.key);
      await activityService.recordInTransaction(tx, {
        workspaceId,
        projectId: created.id,
        actorId: userId,
        type: 'PROJECT_CREATED',
        summary: `${input.name} project created`,
        metadata: { key: created.key },
      });
      const invitees = [...new Set((input.memberIds ?? []).filter(id => id !== userId))];
      if (invitees.length) {
        await notificationsService.createMany(
          tx,
          invitees.map(recipientId => ({
            recipientId,
            workspaceId,
            projectId: created.id,
            type: 'PROJECT_ADDED' as const,
            title: `You were added to ${input.name}`,
            body: `${userId ? 'A teammate' : 'You'} added you to this project.`,
            actorId: userId,
            link: `/app/workspaces/${workspaceId}/projects/${created.id}`,
          })),
        );
      }
      return created;
    });

    await workspacesService.ensureDefaultChannels(workspaceId, [project.id]);
    logger.info('project created', { projectId: project.id, workspaceId, userId });
    return this.get(userId, project.id);
  },

  async update(userId: string, projectId: string, input: UpdateProjectInput) {
    const access = await this.assertAccess(userId, projectId);
    authorize(access.role, 'project:update', { message: 'Only owners and admins can edit projects' });

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.color) data.color = input.color;
    if (input.startDate !== undefined) data.startDate = input.startDate ?? null;
    if (input.dueDate !== undefined) data.dueDate = input.dueDate ?? null;
    if (input.status) {
      data.status = input.status;
      data.archivedAt = input.status === 'ARCHIVED' ? new Date() : null;
    }

    await prisma.$transaction(async tx => {
      await tx.project.update({ where: { id: projectId }, data: data as never });
      const summary =
        input.status === 'ARCHIVED' ? `${access.project.name} was archived` : input.status ? `${access.project.name} moved to ${input.status}` : `${access.project.name} was updated`;
      await activityService.recordInTransaction(tx, {
        workspaceId: access.workspaceId,
        projectId,
        actorId: userId,
        type: input.status === 'ARCHIVED' ? 'PROJECT_ARCHIVED' : 'PROJECT_UPDATED',
        summary,
        metadata: { changes: Object.keys(data) },
      });
    });

    const updated = await this.get(userId, projectId);
    realtime.toWorkspace(access.workspaceId, 'project:updated', { workspaceId: access.workspaceId, project: updated });
    return updated;
  },

  async archive(userId: string, projectId: string, archived: boolean) {
    return this.update(userId, projectId, { status: archived ? 'ARCHIVED' : 'ACTIVE' });
  },

  async remove(userId: string, projectId: string) {
    const access = await this.assertAccess(userId, projectId);
    authorize(access.role, 'project:delete', { message: 'Only owners and admins can delete projects' });
    const [taskCount, memberCount] = await Promise.all([
      prisma.task.count({ where: { projectId } }),
      prisma.projectMember.count({ where: { projectId } }),
    ]);
    await prisma.project.delete({ where: { id: projectId } });
    await activityService.record({
      workspaceId: access.workspaceId,
      actorId: userId,
      type: 'PROJECT_DELETED',
      summary: `${access.project.name} was deleted (${taskCount} tasks)`,
    });
    realtime.toWorkspace(access.workspaceId, 'project:deleted', { workspaceId: access.workspaceId, projectId });
    logger.warn('project deleted', { projectId, taskCount, memberCount, by: userId });
    return { id: projectId, deletedTasks: taskCount };
  },

  /* ─────────────────────────────── members ─────────────────────────────── */

  async listMembers(userId: string, projectId: string) {
    const access = await this.assertAccess(userId, projectId);
    const members = await prisma.projectMember.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: publicUserSelect } },
    });
    const allWorkspaceMembers = access.role ? await prisma.workspaceMember.findMany({
      where: { workspaceId: access.workspaceId },
      include: { user: { select: publicUserSelect } },
      orderBy: { joinedAt: 'asc' },
    }) : [];
    const memberIds = new Set(members.map(m => m.userId));
    return serialize({
      members: members.map(m => ({ id: m.id, joinedAt: m.createdAt, user: publicUser(m.user) })),
      candidates: allWorkspaceMembers
        .filter(candidate => !memberIds.has(candidate.userId))
        .map(candidate => ({ id: candidate.id, role: candidate.role, user: publicUser(candidate.user) })),
    });
  },

  async addMembers(userId: string, projectId: string, userIds: string[]) {
    const access = await this.assertAccess(userId, projectId);
    authorize(access.role, 'project:manageMembers', { message: 'Only managers can change project members' });
    const valid = await prisma.workspaceMember.findMany({ where: { workspaceId: access.workspaceId, userId: { in: userIds } }, select: { userId: true } });
    const validIds = valid.map(v => v.userId);
    if (validIds.length === 0) throw notFound('None of the selected users are workspace members');

    await prisma.$transaction(async tx => {
      for (const memberId of validIds) {
        await tx.projectMember.upsert({
          where: { projectId_userId: { projectId, userId: memberId } },
          update: {},
          create: { projectId, userId: memberId },
        });
      }
      await activityService.recordInTransaction(tx, {
        workspaceId: access.workspaceId,
        projectId,
        actorId: userId,
        type: 'MEMBER_ADDED',
        summary: `${validIds.length} member${validIds.length === 1 ? '' : 's'} added to ${access.project.name}`,
      });
      await notificationsService.createMany(
        tx,
        validIds
          .filter(id => id !== userId)
          .map(recipientId => ({
            recipientId,
            workspaceId: access.workspaceId,
            projectId,
            type: 'PROJECT_ADDED' as const,
            title: `You were added to ${access.project.name}`,
            actorId: userId,
            link: `/app/workspaces/${access.workspaceId}/projects/${projectId}`,
          })),
      );
    });

    const updated = await this.get(userId, projectId);
    realtime.toWorkspace(access.workspaceId, 'project:updated', { workspaceId: access.workspaceId, project: updated });
    return { added: validIds.length };
  },

  async removeMember(userId: string, projectId: string, memberId: string) {
    const access = await this.assertAccess(userId, projectId);
    authorize(access.role, 'project:manageMembers', { message: 'Only managers can change project members' });
    const member = await prisma.projectMember.findUnique({ where: { id: memberId }, include: { user: { select: { id: true, name: true } } } });
    if (!member || member.projectId !== projectId) throw notFound('Project member not found');

    await prisma.$transaction(async tx => {
      await tx.projectMember.delete({ where: { id: memberId } });
      // Unassign their tasks so the board never shows work assigned to an outsider.
      await tx.task.updateMany({
        where: { projectId, assigneeId: member.userId },
        data: { assigneeId: null },
      });
      await activityService.recordInTransaction(tx, {
        workspaceId: access.workspaceId,
        projectId,
        actorId: userId,
        type: 'MEMBER_REMOVED',
        summary: `${member.user.name} was removed from ${access.project.name}`,
      });
    });

    const updated = await this.get(userId, projectId);
    realtime.toWorkspace(access.workspaceId, 'project:updated', { workspaceId: access.workspaceId, project: updated });
    return { id: memberId };
  },
};
