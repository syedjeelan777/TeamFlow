import type { RequestHandler } from 'express';
import { currentUser } from './auth.js';
import { badRequest, ERROR_CODES, AppError } from '../lib/errors.js';
import { workspacesService } from '../services/workspaces.service.js';
import { projectsService } from '../services/projects.service.js';
import { tasksService } from '../services/tasks.service.js';
import { channelsService } from '../services/channels.service.js';
import { commentsService } from '../services/comments.service.js';
import { messagesService } from '../services/messages.service.js';
import { isUuid } from '../lib/ids.js';

function guard(resolve: (userId: string, req: Parameters<RequestHandler>[0]) => Promise<void>): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      try {
        await resolve(currentUser(req).id, req);
        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

const id = (value: string | undefined, label: string) => {
  if (!value) throw badRequest(`${label} is required`);
  if (!isUuid(value)) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${label} must be a valid id`, 422);
  return value;
};

/** Workspace-scoped route groups (`/api/workspaces/:workspaceId/*`). */
export const requireWorkspaceScope = () =>
  guard(async (userId, req) => {
    const workspaceId = id(String(req.params.workspaceId), 'workspaceId');
    req.workspaceAccess = await workspacesService.assertMembership(userId, workspaceId);
  });

/** `/api/projects/:projectId/*` — workspace + project visibility. */
export const requireProjectScope = () =>
  guard(async (userId, req) => {
    const projectId = id(String(req.params.projectId), 'projectId');
    const access = await projectsService.assertAccess(userId, projectId);
    req.workspaceAccess = { workspaceId: access.workspaceId, role: access.role };
  });

/** `/api/tasks/:taskId/*` */
export const requireTaskScope = () =>
  guard(async (userId, req) => {
    const taskId = id(String(req.params.taskId), 'taskId');
    const { task, role } = await tasksService.assertAccess(userId, taskId);
    req.workspaceAccess = { workspaceId: task.workspaceId, role };
  });

/** `/api/comments/:commentId` and `/api/attachments/:attachmentId` */
export const requireCommentScope = () =>
  guard(async (userId, req) => {
    await commentsService.assertCommentAccess(userId, id(String(req.params.commentId), 'commentId'));
  });

export const requireAttachmentScope = () =>
  guard(async (userId, req) => {
    await commentsService.assertAttachmentAccess(userId, id(String(req.params.attachmentId), 'attachmentId'));
  });

/** `/api/channels/:channelId/*` */
export const requireChannelScope = () =>
  guard(async (userId, req) => {
    const { channel } = await channelsService.assertAccess(userId, id(String(req.params.channelId), 'channelId'));
    req.workspaceAccess = { workspaceId: channel.workspaceId, role: channel.role };
  });

/** `/api/messages/:messageId` */
export const requireMessageScope = () =>
  guard(async (userId, req) => {
    await messagesService.assertMessageAccess(userId, id(String(req.params.messageId), 'messageId'));
  });

/** Top-level routes that take `?workspaceId=` (activity, search, analytics). */
export const requireWorkspaceScopeFromQuery = () =>
  guard(async (userId, req) => {
    const workspaceId = id(String(req.query.workspaceId ?? req.params.workspaceId), 'workspaceId');
    req.workspaceAccess = await workspacesService.assertMembership(userId, workspaceId);
  });
