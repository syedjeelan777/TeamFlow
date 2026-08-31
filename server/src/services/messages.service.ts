import { ERROR_CODES, forbidden, notFound } from '../lib/errors.js';
import { AppError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { publicUser, publicUserSelect, serialize } from '../lib/serialize.js';
import { can } from '../lib/permissions.js';
import { channelsService } from './channels.service.js';
import { workspacesService } from './workspaces.service.js';
import { notificationsService } from './notifications.service.js';
import { activityService } from './activity.service.js';
import { realtime } from './realtime.service.js';
import { logger } from '../config/logger.js';
import { SERVER_EVENTS } from '@teamflow/shared';

const messageSelect = {
  id: true,
  channelId: true,
  body: true,
  createdAt: true,
  editedAt: true,
  deletedAt: true,
  seq: true,
  author: { select: publicUserSelect },
} as const;

/**
 * Per-user high-water mark for read receipts.
 * Intentionally in-memory: unread badges are a convenience, not an audit log,
 * and this keeps write traffic off PostgreSQL (see spec §17).
 */
const lastReadSeq = new Map<string, bigint>();
const readKey = (userId: string, channelId: string) => `${userId}:${channelId}`;

export const messagesService = {
  async list(userId: string, channelId: string, options: { limit: number; before?: number }) {
    const { channel } = await channelsService.assertAccess(userId, channelId);
    const rows = await prisma.message.findMany({
      where: {
        channelId: channel.id,
        ...(options.before ? { seq: { lt: BigInt(options.before) } } : {}),
      },
      orderBy: [{ seq: 'desc' }],
      take: options.limit + 1,
      select: messageSelect,
    });
    const hasMore = rows.length > options.limit;
    const page = (hasMore ? rows.slice(0, options.limit) : rows).map(row => toDto(row));
    // Clients want chronological order; the DB query is newest-first.
    page.reverse();
    const oldestSeq = page[0]?.seq;
    const newestSeq = rows[0]?.seq;
    // Opening a channel marks everything up to its newest message as read.
    lastReadSeq.set(readKey(userId, channel.id), newestSeq ?? BigInt(0));
    return {
      items: serialize(page),
      nextCursor: hasMore && oldestSeq ? BigInt(oldestSeq).toString() : null,
      hasMore,
      lastReadSeq: (newestSeq ?? BigInt(0)).toString(),
    };
  },

  async create(userId: string, channelId: string, body: string, clientId?: string) {
    const { channel } = await channelsService.assertAccess(userId, channelId);
    const actor = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, name: true } });
    const mentionNames = extractMentions(body);

    const { message, pending } = await prisma.$transaction(async tx => {
      const created = await tx.message.create({
        data: { channelId: channel.id, authorId: userId, body },
        select: messageSelect,
      });
      if (channel.projectId) {
        await activityService.recordInTransaction(tx, {
          workspaceId: channel.workspaceId,
          projectId: channel.projectId,
          actorId: userId,
          type: 'MESSAGE_SENT',
          summary: `${actor.name} posted in #${channel.name}`,
          metadata: { channelId: channel.id },
        });
      }

      let mentionedIds: string[] = [];
      if (mentionNames.length) {
        const members = await tx.workspaceMember.findMany({
          where: { workspaceId: channel.workspaceId },
          select: { userId: true, user: { select: { id: true, name: true } } },
        });
        mentionedIds = members
          .filter(member => {
            const name = member.user.name.toLowerCase();
            const first = name.split(' ')[0] ?? '';
            const handle = name.replace(/\s+/g, '');
            return member.userId !== userId && (mentionNames.includes(handle) || mentionNames.includes(name) || mentionNames.includes(first));
          })
          .map(member => member.userId);
      }
      const pending = mentionedIds.length
        ? await notificationsService.createMany(
            tx,
            [...new Set(mentionedIds)].map(recipientId => ({
              recipientId,
              workspaceId: channel.workspaceId,
              channelId: channel.id,
              type: 'MENTION' as const,
              title: `${actor.name} mentioned you in #${channel.name}`,
              body: body.slice(0, 140),
              actorId: userId,
              link: `/app/workspaces/${channel.workspaceId}/chat?channel=${channel.id}`,
            })),
          )
        : [];
      return { message: created, pending };
    });

    const dto = toDto(message);
    const payload = { workspaceId: channel.workspaceId, channelId: channel.id, message: serialize(dto), ...(clientId ? { clientId } : {}) };
    realtime.toChannel(channel.id, SERVER_EVENTS.messageNew, payload);
    realtime.toWorkspace(channel.workspaceId, 'channel:message', payload);
    lastReadSeq.set(readKey(userId, channel.id), message.seq);
    await notificationsService.deliverAll(pending);
    return serialize({ ...dto, clientId: clientId ?? null });
  },

  async update(userId: string, messageId: string, body: string) {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, authorId: true, deletedAt: true, channel: { select: { id: true, workspaceId: true } } },
    });
    if (!message || message.deletedAt) throw notFound('Message not found', ERROR_CODES.MESSAGE_NOT_FOUND);
    if (message.authorId !== userId) throw forbidden('You can only edit your own messages');
    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { body, editedAt: new Date() },
      select: messageSelect,
    });
    const dto = serialize(toDto(updated));
    realtime.toChannel(message.channel.id, SERVER_EVENTS.messageUpdated, {
      workspaceId: message.channel.workspaceId,
      channelId: message.channel.id,
      messageId,
      message: dto,
    });
    return dto;
  },

  async remove(userId: string, messageId: string) {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, authorId: true, channel: { select: { id: true, workspaceId: true } } },
    });
    if (!message) throw notFound('Message not found', ERROR_CODES.MESSAGE_NOT_FOUND);
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: message.channel.workspaceId, userId } },
      select: { role: true },
    });
    if (!membership) throw new AppError(ERROR_CODES.NOT_A_MEMBER, 'You are not a member of this workspace', 403);
    if (message.authorId !== userId && !can(membership.role, 'message:delete:any')) {
      throw forbidden('You can only delete your own messages');
    }
    await prisma.message.update({ where: { id: messageId }, data: { deletedAt: new Date(), body: '' } });
    realtime.toChannel(message.channel.id, SERVER_EVENTS.messageDeleted, {
      workspaceId: message.channel.workspaceId,
      channelId: message.channel.id,
      messageId,
    });
    logger.info('message deleted', { messageId, by: userId, self: message.authorId === userId });
    return { id: messageId };
  },

  /** Authorisation helper for `/api/messages/:messageId`. */
  async assertMessageAccess(userId: string, messageId: string) {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, authorId: true, channel: { select: { workspaceId: true } } },
    });
    if (!message) throw notFound('Message not found', ERROR_CODES.MESSAGE_NOT_FOUND);
    await workspacesService.assertMembership(userId, message.channel.workspaceId);
    return message;
  },

  /** Read receipts: keeps the badge truthful without a DB table. */
  markRead(userId: string, channelId: string, seq: string | bigint) {
    const value = typeof seq === 'bigint' ? seq : BigInt(seq);
    const key = readKey(userId, channelId);
    const current = lastReadSeq.get(key) ?? 0n;
    if (value > current) lastReadSeq.set(key, value);
    return { channelId, lastReadSeq: value.toString() };
  },

  /** Unread badge for a channel: newest seq minus the in-memory receipt. */
  async unreadCountFor(userId: string, channelId: string) {
    const [top] = await prisma.message.findMany({
      where: { channelId },
      orderBy: { seq: 'desc' },
      take: 1,
      select: { seq: true },
    });
    return this.unreadCount(userId, channelId, top?.seq ?? 0n);
  },

  unreadCount(userId: string, channelId: string, latestSeq: bigint | number) {
    const read = lastReadSeq.get(readKey(userId, channelId)) ?? 0n;
    const latest = typeof latestSeq === 'bigint' ? latestSeq : BigInt(latestSeq);
    return Number(latest > read ? latest - read : 0n);
  },

  resetReadState() {
    lastReadSeq.clear();
  },
};

interface MessageRow {
  id: string;
  channelId: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  seq: bigint;
  author?: Parameters<typeof publicUser>[0];
}

/** Raw row → client shape (dates are serialised later by `serialize`). */
function toDto(row: MessageRow) {
  return {
    id: row.id,
    channelId: row.channelId,
    // Tombstone: the row stays for thread continuity, the content is gone.
    body: row.deletedAt ? '' : row.body,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    deletedAt: row.deletedAt,
    seq: row.seq.toString(),
    author: row.author ? publicUser(row.author) : null,
  };
}

function extractMentions(body: string): string[] {
  const matches = body.match(/(^|\s)@([a-zA-Z][\w.-]{1,40})/g) ?? [];
  return [...new Set(matches.map(m => m.trim().slice(1).toLowerCase()))];
}
