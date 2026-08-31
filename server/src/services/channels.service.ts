import { ERROR_CODES, conflict, forbidden, notFound } from '../lib/errors.js';
import { AppError } from '../lib/errors.js';
import { prisma, type TransactionClient } from '../lib/prisma.js';
import { publicUser, publicUserSelect, serialize } from '../lib/serialize.js';
import { authorize } from '../lib/permissions.js';
import { workspacesService } from './workspaces.service.js';
import { messagesService } from './messages.service.js';
import { mapLimited } from '../utils/map-limited.js';
import { logger } from '../config/logger.js';

export const DEFAULT_CHANNELS = ['general', 'development', 'frontend', 'backend', 'testing'] as const;

const channelSelect = {
  id: true,
  workspaceId: true,
  name: true,
  topic: true,
  type: true,
  projectId: true,
  createdAt: true,
  project: { select: { id: true, name: true, key: true, color: true } },
} as const;

export const channelsService = {
  async listForUser(userId: string, workspaceId: string) {
    await workspacesService.assertMembership(userId, workspaceId);
    const channels = await prisma.channel.findMany({
      where: { workspaceId },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
      select: { ...channelSelect },
    });

    // Bounded fan-out: one lightweight read per channel for the preview and the
    // unread badge, never more than four queries in flight.
    const detailed = await mapLimited(channels, 4, async channel => {
      const [last, unreadCount] = await Promise.all([
        prisma.message.findFirst({
          where: { channelId: channel.id },
          orderBy: { seq: 'desc' },
          select: { createdAt: true, body: true, author: { select: publicUserSelect } },
        }),
        messagesService.unreadCountFor(userId, channel.id),
      ]);
      return { channel, last, unreadCount };
    });

    return serialize(
      detailed.map(({ channel, last, unreadCount }) => ({
        id: channel.id,
        workspaceId: channel.workspaceId,
        name: channel.name,
        topic: channel.topic,
        type: channel.type,
        projectId: channel.projectId,
        createdAt: channel.createdAt,
        project: channel.project,
        lastMessageAt: last?.createdAt ?? null,
        lastMessagePreview: last?.body?.slice(0, 90) ?? null,
        lastMessageAuthor: last?.author ? publicUser(last.author) : null,
        unreadCount,
      })),
    );
  },

  async assertAccess(userId: string, channelId: string, tx: TransactionClient = prisma) {
    const channel = await tx.channel.findUnique({
      where: { id: channelId },
      select: { id: true, workspaceId: true, name: true, type: true, projectId: true },
    });
    if (!channel) throw notFound('Channel not found', ERROR_CODES.CHANNEL_NOT_FOUND);
    const membership = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: channel.workspaceId, userId } },
      select: { role: true },
    });
    if (!membership) throw new AppError(ERROR_CODES.NOT_A_MEMBER, 'You are not a member of this workspace', 403);
    return { channel: { ...channel, role: membership.role }, role: membership.role };
  },

  /** Used by the authz middleware for `/api/channels/:channelId/*`. */
  async assertWorkspaceAccess(userId: string, channelId: string) {
    return this.assertAccess(userId, channelId);
  },

  async create(userId: string, workspaceId: string, input: { name: string; topic?: string; projectId?: string }) {
    const { role } = await workspacesService.assertMembership(userId, workspaceId);
    authorize(role, 'channel:create', { message: 'Only owners and admins can create channels' });
    if (input.projectId) {
      const project = await prisma.project.findFirst({ where: { id: input.projectId, workspaceId }, select: { id: true, key: true } });
      if (!project) throw notFound('Project not found in this workspace');
    }
    const existing = await prisma.channel.findFirst({ where: { workspaceId, name: input.name }, select: { id: true } });
    if (existing) throw conflict(`#${input.name} already exists in this workspace`);
    const channel = await prisma.channel.create({
      data: {
        workspaceId,
        name: input.name,
        topic: input.topic ?? null,
        projectId: input.projectId ?? null,
        type: input.projectId ? 'PROJECT' : 'GENERAL',
      },
      select: channelSelect,
    });
    logger.info('channel created', { channelId: channel.id, workspaceId, by: userId });
    return serialize(channel);
  },

  async ensureProjectChannel(tx: TransactionClient, workspaceId: string, projectId: string, key: string) {
    const name = `proj-${key.toLowerCase()}`;
    const existing = await tx.channel.findFirst({ where: { workspaceId, projectId }, select: { id: true } });
    if (existing) return existing.id;
    const channel = await tx.channel.create({ data: { workspaceId, projectId, name, type: 'PROJECT' }, select: { id: true } });
    return channel.id;
  },

  async remove(userId: string, channelId: string) {
    const { channel, role } = await this.assertAccess(userId, channelId);
    if (DEFAULT_CHANNELS.includes(channel.name as (typeof DEFAULT_CHANNELS)[number])) {
      throw forbidden('Default workspace channels cannot be deleted');
    }
    authorize(role, 'channel:create', { message: 'Only owners and admins can delete channels' });
    await prisma.channel.delete({ where: { id: channelId } });
    return { id: channelId };
  },

  async update(userId: string, channelId: string, data: { topic?: string | null }) {
    const { channel, role } = await this.assertAccess(userId, channelId);
    authorize(role, 'channel:create', { message: 'Only owners and admins can edit channels' });
    const updated = await prisma.channel.update({ where: { id: channel.id }, data, select: channelSelect });
    return serialize(updated);
  },
};
