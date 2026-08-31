import type { Request, RequestHandler } from 'express';
import { authorize, type Capability } from '../lib/permissions.js';
import { currentUser } from './auth.js';
import { workspacesService } from '../services/workspaces.service.js';
import { projectsService } from '../services/projects.service.js';
import type { WorkspaceRole } from '../generated/prisma/enums.js';

export interface Scope {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
  projectId?: string;
}

/**
 * `POST /api/workspaces/:workspaceId/...` style guard.
 * Membership is resolved from the *database*, never from the client.
 */
export function requireWorkspaceScope(): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      try {
        const user = currentUser(req);
        const workspaceId = String(req.params.workspaceId ?? req.body.workspaceId ?? '');
        if (!workspaceId) throw new Error('workspaceId is required');
        const access = await workspacesService.assertMembership(user.id, workspaceId);
        req.workspaceAccess = access;
        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

export function requireCapability(capability: Capability): RequestHandler {
  return (req, _res, next) => {
    try {
      const access = req.workspaceAccess;
      if (!access) {
        throw new Error('requireCapability must run after a scope middleware');
      }
      authorize(access.role, capability);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * `PATCH /api/projects/:projectId` style guard: resolves project access
 * (workspace membership + project membership / manager override).
 */
export function requireProjectScope(): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      try {
        const user = currentUser(req);
        const projectId = String(req.params.projectId ?? '');
        if (!projectId) throw new Error('projectId is required');
        const access = await projectsService.assertAccess(user.id, projectId);
        req.workspaceAccess = { workspaceId: access.workspaceId, role: access.role };
        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

export function scope(req: Request): Scope {
  const user = currentUser(req);
  const workspaceId = req.workspaceAccess?.workspaceId ?? '';
  return {
    userId: user.id,
    workspaceId,
    role: req.workspaceAccess?.role ?? 'MEMBER',

  };
}
