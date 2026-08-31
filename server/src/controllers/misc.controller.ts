import type { Request, Response } from 'express';
import { asyncHandler, ok } from '../utils/async-handler.js';
import { currentUser } from '../middleware/auth.js';
import { notificationsService } from '../services/notifications.service.js';
import { activityService } from '../services/activity.service.js';
import { analyticsService } from '../services/analytics.service.js';
import { searchService } from '../services/search.service.js';
import { workspacesService } from '../services/workspaces.service.js';
import { presenceService } from '../services/presence.service.js';
import { ActivityListQuery, MarkAllReadSchema, NotificationListQuery } from '../validators/chat.schema.js';
import { SearchQuery } from '../validators/task.schema.js';
import { validate } from '../middleware/validate.js';
import { bodyOf, queryOf } from '../validators/common.js';
import { badRequest } from '../lib/errors.js';

export const notificationsController = {
  list: [
    validate({ query: NotificationListQuery }),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await notificationsService.list(currentUser(req).id, queryOf(req, NotificationListQuery)));
    }),
  ],

  unreadCount: asyncHandler(async (req: Request, res: Response) => {
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
    ok(res, { unreadCount: await notificationsService.unreadCount(currentUser(req).id, workspaceId) });
  }),

  markRead: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await notificationsService.markRead(currentUser(req).id, String(req.params.id)));
  }),

  markAllRead: [
    validate({ body: MarkAllReadSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as { workspaceId?: string };
      ok(res, await notificationsService.markAllRead(currentUser(req).id, body.workspaceId));
    }),
  ],

  remove: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await notificationsService.remove(currentUser(req).id, String(req.params.id)));
  }),
};

export const activityController = {
  /** Accepts `workspaceId` from the path (nested) or the query (top level). */
  list: [
    validate({ query: ActivityListQuery }),
    asyncHandler(async (req: Request, res: Response) => {
      const query = queryOf(req, ActivityListQuery);
      const workspaceId = query.workspaceId ?? String(req.params.workspaceId ?? '');
      if (!workspaceId) throw badRequest('workspaceId is required');
      await workspacesService.assertMembership(currentUser(req).id, workspaceId);
      const result = await activityService.list({ ...query, workspaceId });
      ok(res, result);
    }),
  ],
};

export const analyticsController = {
  workspace: asyncHandler(async (req: Request, res: Response) => {
    const rawDays = Number((req.query as { days?: unknown }).days ?? 84);
    const days = Number.isFinite(rawDays) ? Math.min(Math.max(rawDays, 7), 365) : 84;
    ok(res, await analyticsService.workspace(currentUser(req).id, String(req.params.workspaceId), days));
  }),
};

export const searchController = {
  /**
   * Works as `/api/workspaces/:workspaceId/search` and as
   * `/api/search?workspaceId=…` — the query value wins when both are present.
   */
  workspace: [
    validate({ query: SearchQuery }),
    asyncHandler(async (req: Request, res: Response) => {
      const query = queryOf(req, SearchQuery);
      const workspaceId = query.workspaceId ?? String(req.params.workspaceId ?? '');
      ok(res, await searchService.workspace(currentUser(req).id, workspaceId, queryOf(req, SearchQuery)));
    }),
  ],

  global: [
    validate({ query: SearchQuery }),
    asyncHandler(async (req: Request, res: Response) => {
      const query = queryOf(req, SearchQuery);
      if (!query.workspaceId) throw badRequest('workspaceId is required for search');
      const result = await searchService.workspace(currentUser(req).id, query.workspaceId!, queryOf(req, SearchQuery));
      ok(res, result);
    }),
  ],
};

export const presenceController = {
  workspace: asyncHandler(async (req: Request, res: Response) => {
    const workspaceId = String(req.params.workspaceId);
    await workspacesService.assertMembership(currentUser(req).id, workspaceId);
    ok(res, {
      onlineUserIds: presenceService.onlineUserIdsInWorkspace(workspaceId),
      connections: presenceService.stats(),
    });
  }),
};
