import type { ActivityType } from '../generated/prisma/enums.js';
import { prisma, type TransactionClient } from '../lib/prisma.js';
import { logger } from '../config/logger.js';

export interface RecordActivityInput {
  workspaceId: string;
  type: ActivityType;
  summary: string;
  actorId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  commentId?: string | null;
  metadata?: Record<string, unknown> | null;
  tx?: TransactionClient;
}

/**
 * Activity is written as part of the mutating transaction whenever the caller
 * passes `tx`, so a task move can never be persisted without its timeline entry.
 */
export const activityService = {
  async recordInTransaction(tx: TransactionClient, input: Omit<RecordActivityInput, 'tx'>) {
    return tx.activityLog.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId ?? null,
        taskId: input.taskId ?? null,
        commentId: input.commentId ?? null,
        actorId: input.actorId ?? null,
        type: input.type,
        summary: input.summary,
        metadata: (input.metadata ?? undefined) as never,
      },
      select: { id: true, createdAt: true },
    });
  },

  async record(input: RecordActivityInput) {
    const client = input.tx ?? prisma;
    try {
      return await this.recordInTransaction(client, input);
    } catch (error) {
      // Activity is a side-channel: losing it must not fail the user's action,
      // but it must be loud in the logs.
      logger.error(error, { context: 'activity.record', workspaceId: input.workspaceId, type: input.type });
      return null;
    }
  },

  async list(options: { workspaceId: string; projectId?: string; taskId?: string; limit: number; before?: string }) {
    const items = await prisma.activityLog.findMany({
      where: {
        workspaceId: options.workspaceId,
        ...(options.projectId ? { projectId: options.projectId } : {}),
        ...(options.taskId ? { taskId: options.taskId } : {}),
        ...(options.before ? { createdAt: { lt: new Date(options.before) } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }],
      take: options.limit + 1,
      select: {
        id: true,
        type: true,
        summary: true,
        createdAt: true,
        taskId: true,
        projectId: true,
        metadata: true,
        actor: { select: { id: true, name: true, email: true, avatarUrl: true, bio: true, createdAt: true } },
      },
    });
    const hasMore = items.length > options.limit;
    return { items: hasMore ? items.slice(0, options.limit) : items, hasMore };
  },
};
