import { ERROR_CODES, forbidden, notFound } from '../lib/errors.js';
import { AppError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { publicUser, publicUserSelect, serialize } from '../lib/serialize.js';
import { authorize, can } from '../lib/permissions.js';
import { activityService } from './activity.service.js';
import { notificationsService } from './notifications.service.js';
import { tasksService } from './tasks.service.js';
import { workspacesService } from './workspaces.service.js';
import { realtime } from './realtime.service.js';
import { SERVER_EVENTS } from '@teamflow/shared';
import { logger } from '../config/logger.js';

const commentSelect = {
  id: true,
  taskId: true,
  body: true,
  createdAt: true,
  updatedAt: true,
  editedAt: true,
  author: { select: publicUserSelect },
} as const;

/** `@name` mentions are matched on full display names and on first names. */
function extractMentions(body: string): string[] {
  const matches = body.match(/(^|\s)@([a-zA-Z][\w.-]{1,40})/g) ?? [];
  return [...new Set(matches.map(m => m.trim().slice(1).toLowerCase()))];
}

export const commentsService = {
  async list(userId: string, taskId: string) {
    await tasksService.assertAccess(userId, taskId);
    const comments = await prisma.comment.findMany({
      where: { taskId },
      orderBy: [{ createdAt: 'asc' }],
      take: 200,
      select: commentSelect,
    });
    return serialize(comments.map(c => ({ ...c, author: publicUser(c.author) })));
  },

  async create(userId: string, taskId: string, body: string) {
    const { task } = await tasksService.assertAccess(userId, taskId);
    const actor = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, name: true } });
    const mentionedNames = extractMentions(body);

    const result = await prisma.$transaction(async tx => {
      const comment = await tx.comment.create({
        data: { taskId, authorId: userId, body },
        select: commentSelect,
      });
      await tx.task.update({ where: { id: taskId }, data: { updatedAt: new Date() } });

      const recipients = new Set<string>();
      if (task.assigneeId && task.assigneeId !== userId) recipients.add(task.assigneeId);
      // Reporter gets a note only when they are not the author.
      if (task.reporterId && task.reporterId !== userId) recipients.add(task.reporterId);

      let mentionedUsers: { id: string }[] = [];
      if (mentionedNames.length) {
        const members = await tx.workspaceMember.findMany({
          where: { workspaceId: task.workspaceId },
          select: { userId: true, user: { select: { id: true, name: true } } },
        });
        mentionedUsers = members
          .filter(member => {
            const name = member.user.name.toLowerCase();
            const first = name.split(' ')[0]?.toLowerCase();
            return mentionedNames.includes(name.replace(/\s+/g, '')) || mentionedNames.includes(name) || (first ? mentionedNames.includes(first) : false);
          })
          .map(member => ({ id: member.userId }));
      }
      const mentionedIds = mentionedUsers.map(m => m.id).filter(id => id !== userId);

      const pending = await notificationsService.createMany(tx, [
        ...[...recipients].map(recipientId => ({
          recipientId,
          workspaceId: task.workspaceId,
          projectId: task.projectId,
          taskId,
          commentId: comment.id,
          type: 'TASK_COMMENTED' as const,
          title: `${actor.name} commented on ${task.reference}`,
          body: body.slice(0, 140),
          actorId: userId,
          link: `/app/workspaces/${task.workspaceId}/projects/${task.projectId}/tasks/${taskId}`,
        })),
        ...[...new Set(mentionedIds)].map(recipientId => ({
          recipientId,
          workspaceId: task.workspaceId,
          projectId: task.projectId,
          taskId,
          commentId: comment.id,
          type: 'MENTION' as const,
          title: `${actor.name} mentioned you in ${task.reference}`,
          body: body.slice(0, 140),
          actorId: userId,
          link: `/app/workspaces/${task.workspaceId}/projects/${task.projectId}/tasks/${taskId}`,
        })),
      ]);

      await activityService.recordInTransaction(tx, {
        workspaceId: task.workspaceId,
        projectId: task.projectId,
        taskId,
        commentId: comment.id,
        actorId: userId,
        type: 'COMMENT_CREATED',
        summary: `${actor.name} commented on ${task.reference}`,
      });
      return { comment: { ...comment, author: publicUser(comment.author) }, pending, mentionedIds: [...new Set(mentionedIds)] };
    });

    realtime.toProject(task.projectId, SERVER_EVENTS.commentCreated, {
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      taskId,
      comment: serialize(result.comment),
    });
    realtime.toWorkspace(task.workspaceId, SERVER_EVENTS.commentCreated, {
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      taskId,
      comment: serialize(result.comment),
    });
    await notificationsService.deliverAll(result.pending);
    logger.info('comment created', { taskId, userId, mentions: result.mentionedIds.length });
    return serialize(result.comment);
  },

  /** Authorisation helper for `/api/comments/:commentId`. */
  async assertCommentAccess(userId: string, commentId: string) {
    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
      select: { id: true, authorId: true, task: { select: { id: true, workspaceId: true } } },
    });
    if (!comment) throw notFound('Comment not found', ERROR_CODES.COMMENT_NOT_FOUND);
    await workspacesService.assertMembership(userId, comment.task.workspaceId);
    return comment;
  },

  /** Authorisation helper for `/api/attachments/:attachmentId`. */
  async assertAttachmentAccess(userId: string, attachmentId: string) {
    const attachment = await prisma.attachment.findUnique({
      where: { id: attachmentId },
      select: { id: true, addedById: true, task: { select: { workspaceId: true } } },
    });
    if (!attachment) throw notFound('Attachment not found');
    await workspacesService.assertMembership(userId, attachment.task.workspaceId);
    return attachment;
  },

  async update(userId: string, commentId: string, body: string) {
    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
      select: { id: true, authorId: true, task: { select: { id: true, projectId: true, workspaceId: true } } },
    });
    if (!comment) throw notFound('Comment not found', ERROR_CODES.COMMENT_NOT_FOUND);
    if (comment.authorId !== userId) throw forbidden('You can only edit your own comments');
    const updated = await prisma.comment.update({
      where: { id: commentId },
      data: { body, editedAt: new Date() },
      select: commentSelect,
    });
    const dto = serialize({ ...updated, author: publicUser(updated.author) });
    realtime.toWorkspace(comment.task.workspaceId, 'comment:updated', {
      workspaceId: comment.task.workspaceId,
      projectId: comment.task.projectId,
      taskId: comment.task.id,
      comment: dto,
    });
    return dto;
  },

  async remove(userId: string, commentId: string) {
    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
      select: { id: true, authorId: true, task: { select: { id: true, projectId: true, workspaceId: true } } },
    });
    if (!comment) throw notFound('Comment not found', ERROR_CODES.COMMENT_NOT_FOUND);
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: comment.task.workspaceId, userId } },
      select: { role: true },
    });
    if (!membership) throw new AppError(ERROR_CODES.NOT_A_MEMBER, 'You are not a member of this workspace', 403);
    if (comment.authorId !== userId) authorize(membership.role, 'comment:moderate', { message: 'You can only delete your own comments' });

    await prisma.$transaction(async tx => {
      await tx.comment.delete({ where: { id: commentId } });
      await activityService.recordInTransaction(tx, {
        workspaceId: comment.task.workspaceId,
        projectId: comment.task.projectId,
        taskId: comment.task.id,
        actorId: userId,
        type: 'COMMENT_DELETED',
        summary: can(membership.role, 'comment:moderate') && comment.authorId !== userId ? 'A comment was removed by a moderator' : 'A comment was deleted',
      });
    });
    realtime.toWorkspace(comment.task.workspaceId, SERVER_EVENTS.commentDeleted, {
      workspaceId: comment.task.workspaceId,
      projectId: comment.task.projectId,
      taskId: comment.task.id,
      commentId,
    });
    return { id: commentId };
  },

  /* ───────────────────────────── attachments ───────────────────────────── */

  async listAttachments(userId: string, taskId: string) {
    await tasksService.assertAccess(userId, taskId);
    const items = await prisma.attachment.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
      include: { addedBy: { select: publicUserSelect } },
    });
    return serialize(items.map(item => ({ ...item, addedBy: publicUser(item.addedBy) })));
  },

  async addAttachment(userId: string, taskId: string, label: string, url: string) {
    const { task } = await tasksService.assertAccess(userId, taskId);
    const created = await prisma.attachment.create({
      data: { taskId, label, url, addedById: userId },
      include: { addedBy: { select: publicUserSelect } },
    });
    await activityService.record({
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      taskId,
      actorId: userId,
      type: 'TASK_UPDATED',
      summary: `Linked “${label}” to ${task.reference}`,
    });
    return serialize({ ...created, addedBy: publicUser(created.addedBy) });
  },

  async removeAttachment(userId: string, attachmentId: string) {
    const attachment = await prisma.attachment.findUnique({
      where: { id: attachmentId },
      select: { id: true, addedById: true, task: { select: { id: true, projectId: true, workspaceId: true } } },
    });
    if (!attachment) throw notFound('Attachment not found');
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: attachment.task.workspaceId, userId } },
      select: { role: true },
    });
    if (!membership) throw new AppError(ERROR_CODES.NOT_A_MEMBER, 'You are not a member of this workspace', 403);
    if (attachment.addedById !== userId && !can(membership.role, 'task:delete:any')) {
      throw forbidden('You can only remove links you added');
    }
    await prisma.attachment.delete({ where: { id: attachmentId } });
    return { id: attachmentId };
  },
};
