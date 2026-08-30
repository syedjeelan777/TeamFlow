import { prisma, type TransactionClient } from '../lib/prisma.js';
import { publicUser, serialize } from '../lib/serialize.js';
import { notFound } from '../lib/errors.js';
import type { NotificationType } from '../generated/prisma/enums.js';
import { realtime } from './realtime.service.js';
import { logger } from '../config/logger.js';

export interface CreateNotificationInput {
  recipientId: string;
  workspaceId?: string | null;
  type: NotificationType;
  title: string;
  body?: string | null;
  actorId?: string | null;
  taskId?: string | null;
  projectId?: string | null;
  channelId?: string | null;
  commentId?: string | null;
  link?: string | null;
  /** Defer socket delivery until the surrounding transaction commits. */
  tx?: TransactionClient;
}

const notificationSelect = {
  id: true,
  type: true,
  title: true,
  body: true,
  link: true,
  readAt: true,
  createdAt: true,
  workspaceId: true,
  actor: { select: { id: true, name: true, email: true, avatarUrl: true, bio: true, createdAt: true } },
} as const;

function emit(notification: { id: string; recipientId: string }) {
  void deliver(notification.id, notification.recipientId);
}

async function deliver(notificationId: string, recipientId: string) {
  try {
    const full = await prisma.notification.findUnique({ where: { id: notificationId }, select: notificationSelect });
    if (!full) return;
    realtime.notification(recipientId, { notification: serialize({ ...full, actor: full.actor ? publicUser(full.actor) : null }) });
  } catch (error) {
    // The row is already committed: log, never throw back into the mutation.
    logger.error(error, { context: 'notification.deliver', notificationId });
  }
}

export const notificationsService = {
  async create(input: CreateNotificationInput) {
    const tx = input.tx ?? prisma;
    const created = await tx.notification.create({
      data: {
        recipientId: input.recipientId,
        workspaceId: input.workspaceId ?? null,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        actorId: input.actorId ?? null,
        taskId: input.taskId ?? null,
        projectId: input.projectId ?? null,
        channelId: input.channelId ?? null,
        commentId: input.commentId ?? null,
        link: input.link ?? null,
      },
      select: { id: true, recipientId: true },
    });
    if (!input.tx) emit(created);
    return created;
  },

  /** Used inside transactions: create rows now, fan out after commit. */
  async createMany(tx: TransactionClient, inputs: CreateNotificationInput[]): Promise<{ id: string; recipientId: string }[]> {
    if (inputs.length === 0) return [];
    const created: { id: string; recipientId: string }[] = [];
    for (const input of inputs) {
      const row = await tx.notification.create({
        data: {
          recipientId: input.recipientId,
          workspaceId: input.workspaceId ?? null,
          type: input.type,
          title: input.title,
          body: input.body ?? null,
          actorId: input.actorId ?? null,
          taskId: input.taskId ?? null,
          projectId: input.projectId ?? null,
          channelId: input.channelId ?? null,
          commentId: input.commentId ?? null,
          link: input.link ?? null,
        },
        select: { id: true, recipientId: true },
      });
      created.push(row);
    }
    return created;
  },

  async deliverAll(created: { id: string; recipientId: string }[]) {
    await Promise.all(created.map(row => deliver(row.id, row.recipientId)));
  },

  /** Never notify the actor about their own action. */
  isSelf(actorId: string | null | undefined, recipientId: string) {
    return actorId === recipientId;
  },

  async list(userId: string, options: { limit: number; before?: string; unreadOnly?: boolean; workspaceId?: string }) {
    const items = await prisma.notification.findMany({
      where: {
        recipientId: userId,
        ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
        ...(options.unreadOnly ? { readAt: null } : {}),
        ...(options.before ? { createdAt: { lt: new Date(options.before) } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }],
      take: options.limit + 1,
      select: notificationSelect,
    });
    const hasMore = items.length > options.limit;
    const page = hasMore ? items.slice(0, options.limit) : items;
    return {
      items: serialize(
        page.map(item => ({ ...item, actor: item.actor ? publicUser(item.actor) : null })),
      ),
      hasMore,
      unreadCount: await prisma.notification.count({ where: { recipientId: userId, readAt: null } }),
    };
  },

  async unreadCount(userId: string, workspaceId?: string) {
    return prisma.notification.count({ where: { recipientId: userId, readAt: null, ...(workspaceId ? { workspaceId } : {}) } });
  },

  async markRead(userId: string, notificationId: string) {
    const result = await prisma.notification.updateMany({
      where: { id: notificationId, recipientId: userId },
      data: { readAt: new Date() },
    });
    if (result.count === 0) throw notFound('Notification not found');
    const updated = await prisma.notification.findUniqueOrThrow({ where: { id: notificationId }, select: notificationSelect });
    return serialize({ ...updated, actor: updated.actor ? publicUser(updated.actor) : null });
  },

  async markAllRead(userId: string, workspaceId?: string) {
    const result = await prisma.notification.updateMany({
      where: { recipientId: userId, readAt: null, ...(workspaceId ? { workspaceId } : {}) },
      data: { readAt: new Date() },
    });
    return { count: result.count };
  },

  async remove(userId: string, notificationId: string) {
    const result = await prisma.notification.deleteMany({ where: { id: notificationId, recipientId: userId } });
    if (result.count === 0) throw notFound('Notification not found');
    return { id: notificationId };
  },

  /** Sweep job used by the seed/demo flow and by `npm run db:seed`. */
  async dueSoonSweep(hoursAhead = 48) {
    const cutoff = new Date(Date.now() + hoursAhead * 60 * 60 * 1000);
    const candidates = await prisma.task.findMany({
      where: { status: { not: 'DONE' }, dueDate: { gte: new Date(), lte: cutoff }, assigneeId: { not: null } },
      select: { id: true, reference: true, title: true, workspaceId: true, assigneeId: true, projectId: true, dueDate: true },
      take: 200,
    });
    let created = 0;
    for (const task of candidates) {
      if (!task.assigneeId) continue;
      const already = await prisma.notification.findFirst({
        where: { recipientId: task.assigneeId, taskId: task.id, type: 'TASK_DUE_SOON', createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
        select: { id: true },
      });
      if (already) continue;
      await this.create({
        recipientId: task.assigneeId,
        workspaceId: task.workspaceId,
        type: 'TASK_DUE_SOON',
        title: `“${task.title}” is due soon`,
        body: task.dueDate ? `Due ${new Date(task.dueDate).toDateString()}` : null,
        taskId: task.id,
        projectId: task.projectId,
        link: `/app/workspaces/${task.workspaceId}/tasks?highlight=${task.id}`,
      });
      created += 1;
    }
    if (created) logger.info('due-soon notifications created', { count: created });
    return { created };
  },
};
