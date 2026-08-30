import type { Request, RequestHandler } from 'express';
import { ERROR_CODES, unauthorized } from '../lib/errors.js';
import { verifyAccessToken } from '../utils/tokens.js';
import { prisma } from '../lib/prisma.js';
import type { WorkspaceRole } from '../generated/prisma/enums.js';

export interface RequestUser {
  id: string;
  email: string;
  name: string;
  sessionId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: RequestUser;
      /** Set by the workspace/project scope middleware. */
      workspaceAccess?: { workspaceId: string; role: WorkspaceRole };
    }
  }
}

/** Extracts the bearer token (or `?access_token=` for the Socket.IO handshake). */
export function readBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null;
  const query = req.query.access_token;
  if (typeof query === 'string' && query.length > 0) return query;
  return null;
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  const token = readBearer(req);
  if (!token) {
    next(unauthorized('Missing bearer token', ERROR_CODES.UNAUTHORIZED));
    return;
  }
  try {
    const payload = verifyAccessToken(token);
    void (async () => {
      // Cheap revocation check: an access token is only valid while its session
      // row is alive (logout / password change revoke sessions immediately).
      const session = await prisma.refreshToken.findFirst({
        where: { id: payload.sid, revokedAt: null },
        select: { id: true },
      });
      if (!session) {
        next(unauthorized('Session expired, please sign in again', ERROR_CODES.INVALID_TOKEN));
        return;
      }
      req.user = { id: payload.sub, email: payload.email, name: payload.name, sessionId: payload.sid };
      next();
    })().catch(next);
  } catch (error) {
    next(error);
  }
};

/** Populates `req.user` when a valid token is present but never fails. */
export const optionalAuth: RequestHandler = (req, _res, next) => {
  const token = readBearer(req);
  if (!token) {
    next();
    return;
  }
  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, email: payload.email, name: payload.name, sessionId: payload.sid };
  } catch {
    // Anonymous request is fine here — the route decides what to do next.
  }
  next();
};

export function currentUser(req: Request): RequestUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
