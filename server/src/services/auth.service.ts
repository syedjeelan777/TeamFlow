import { createHash } from 'node:crypto';
import type { Response } from 'express';
import { prisma, type TransactionClient } from '../lib/prisma.js';
import { AppError, ERROR_CODES, conflict, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { logger } from '../config/logger.js';
import { publicUser, serialize } from '../lib/serialize.js';
import {
  REFRESH_COOKIE,
  hashOpaqueToken,
  hashToken,
  randomToken,
  refreshCookieOptions,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../utils/tokens.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { config } from '../config/env.js';
import { workspacesService, type AuthedWorkspace } from './workspaces.service.js';
import { activityService } from './activity.service.js';
import type { LoginInput, RegisterInput, UpdateProfileInput } from '../validators/auth.schema.js';

const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  sessionId: string;
}

export interface LoginResult {
  user: ReturnType<typeof publicUser>;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshExpiresAt: string;
  refreshToken: string;
  workspaces: AuthedWorkspace[];
}

async function issueSession(
  tx: TransactionClient,
  user: { id: string; email: string; name: string; avatarUrl?: string | null; createdAt?: Date },
  userAgent?: string,
): Promise<{ accessToken: string; accessTokenExpiresAt: string; refreshToken: string; refreshExpiresAt: string; sessionId: string }> {
  const refresh = signRefreshToken({ sub: user.id, jti: randomToken(16) });
  const tokenHash = hashToken(refresh.token);
  const record = await tx.refreshToken.create({
    data: { userId: user.id, tokenHash, expiresAt: refresh.expiresAt, userAgent: userAgent?.slice(0, 255) ?? null },
  });
  const access = signAccessToken({ sub: user.id, email: user.email, name: user.name, sid: record.id });
  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt.toISOString(),
    refreshToken: refresh.token,
    refreshExpiresAt: refresh.expiresAt.toISOString(),
    sessionId: record.id,
  };
}

function setRefreshCookie(res: Response, token: string, maxAgeMs: number) {
  res.cookie(REFRESH_COOKIE, token, refreshCookieOptions(maxAgeMs));
}

export const authService = {
  /**
   * Register creates the user *and* their first workspace in one transaction so
   * a half-created account (user without a workspace) can never exist.
   */
  async register(input: RegisterInput, userAgent?: string): Promise<LoginResult> {
    const passwordHash = await hashPassword(input.password);
    const created = await prisma.$transaction(async tx => {
      const existing = await tx.user.findUnique({ where: { email: input.email }, select: { id: true } });
      if (existing) throw conflict('An account with this email already exists', ERROR_CODES.EMAIL_TAKEN);
      const user = await tx.user.create({
        data: { email: input.email, name: input.name, passwordHash },
        select: { id: true, email: true, name: true, avatarUrl: true, bio: true, createdAt: true, lastSeenAt: true },
      });
      const workspace = await workspacesService.createInTransaction(tx, {
        userId: user.id,
        name: input.workspaceName ?? `${input.name.split(' ')[0] || user.name}'s Workspace`,
      });
      await activityService.recordInTransaction(tx, {
        workspaceId: workspace.id,
        actorId: user.id,
        type: 'WORKSPACE_CREATED',
        summary: `${user.name} created the workspace ${workspace.name}`,
      });
      return { user, workspace };
    });

    const session = await prisma.$transaction(tx => issueSession(tx, created.user, userAgent));
    logger.info('user registered', { userId: created.user.id });
    return {
      user: serialize(publicUser(created.user)),
      workspaces: await workspacesService.listForUser(created.user.id),
      ...session,
    };
  },

  async login(input: LoginInput, userAgent?: string): Promise<LoginResult> {
    const user = await prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true, email: true, name: true, passwordHash: true, avatarUrl: true, bio: true, createdAt: true, lastSeenAt: true },
    });
    // Constant-ish work whether or not the account exists → no user enumeration.
    const hash = user?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
    const valid = await verifyPassword(input.password, hash);
    if (!user || !valid) {
      logger.warn('failed login attempt', { email: input.email });
      throw unauthorized('Email or password is incorrect', ERROR_CODES.INVALID_CREDENTIALS);
    }
    await prisma.user.update({ where: { id: user.id }, data: { lastSeenAt: new Date() } });
    const session = await prisma.$transaction(tx => issueSession(tx, user, userAgent));
    return {
      user: serialize(publicUser(user)),
      workspaces: await workspacesService.listForUser(user.id),
      ...session,
    };
  },

  /**
   * Rotation-based refresh: the presented token is revoked, a new one issued in
   * the same transaction. Reuse of an already-rotated token revokes the whole
   * session family (stolen-token detection).
   */
  async refresh(rawToken: string, userAgent?: string): Promise<Omit<LoginResult, 'workspaces'>> {
    if (!rawToken) throw unauthorized('No session token', ERROR_CODES.INVALID_TOKEN);
    const payload = verifyRefreshToken(rawToken);
    const tokenHash = hashToken(rawToken);

    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: { select: { id: true, email: true, name: true, avatarUrl: true, bio: true, createdAt: true, lastSeenAt: true } } },
    });

    if (!stored) {
      // Unknown or already-rotated token: if the JWT itself is valid but the row
      // is gone, treat it as reuse and revoke every session for that user.
      const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true } });
      if (user) {
        await prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
        logger.warn('refresh token reuse detected — all sessions revoked', { userId: user.id });
      }
      throw unauthorized('Session is no longer valid', ERROR_CODES.INVALID_TOKEN);
    }
    if (stored.revokedAt) throw unauthorized('Session was revoked', ERROR_CODES.INVALID_TOKEN);
    if (stored.expiresAt.getTime() < Date.now()) throw unauthorized('Session expired', ERROR_CODES.TOKEN_EXPIRED);

    const session = await prisma.$transaction(async tx => {
      await tx.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
      const issued = await issueSession(tx, stored.user, userAgent ?? stored.userAgent ?? undefined);
      await tx.refreshToken.update({ where: { id: stored.id }, data: { replacedById: issued.sessionId } });
      return issued;
    });

    return { user: serialize(publicUser(stored.user)), ...session };
  },

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    const tokenHash = hashToken(rawToken);
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash }, select: { id: true, userId: true } });
    if (!stored) return;
    await prisma.refreshToken.updateMany({ where: { OR: [{ id: stored.id }, { replacedById: stored.id }] }, data: { revokedAt: new Date() } });
    logger.info('user logged out', { userId: stored.userId });
  },

  async logoutAll(userId: string): Promise<number> {
    const result = await prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    return result.count;
  },

  async me(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, avatarUrl: true, bio: true, createdAt: true, lastSeenAt: true },
    });
    if (!user) throw notFound('Account not found');
    const memberships = await prisma.workspaceMember.count({ where: { userId } });
    return { user: serialize(publicUser(user)), workspaceCount: memberships };
  },

  async updateProfile(userId: string, input: UpdateProfileInput) {
    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.bio !== undefined ? { bio: input.bio || null } : {}),
        ...(input.avatarUrl !== undefined
          ? { avatarUrl: input.avatarUrl ? `${input.avatarUrl.startsWith('http') ? input.avatarUrl : `https:${input.avatarUrl}`}` : null }
          : {}),
      },
      select: { id: true, email: true, name: true, avatarUrl: true, bio: true, createdAt: true, lastSeenAt: true },
    });
    return serialize(publicUser(user));
  },

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } });
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw forbidden('Current password is incorrect', 'INVALID_CREDENTIALS');
    }
    await prisma.$transaction([
      prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(newPassword) } }),
      // Every other session must die; the caller re-authenticates.
      prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    logger.info('password changed', { userId });
  },

  /**
   * Forgot-password never reveals whether the address is registered. The reset
   * link is logged (dev) and returned in non-production responses so the flow
   * is actually testable without an e-mail provider.
   */
  async forgotPassword(email: string): Promise<{ resetUrl: string | null; expiresAt: string | null }> {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
    if (!user) {
      return { resetUrl: null, expiresAt: null };
    }
    const token = randomToken(32);
    const tokenHash = hashOpaqueToken(token);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
    await prisma.$transaction([
      prisma.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } }),
      prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash, expiresAt } }),
    ]);
    const resetUrl = `${config.clientUrl}/reset-password?token=${token}`;
    logger.info('password reset requested', { userId: user.id, resetUrl: config.isProduction ? '[redacted]' : resetUrl });
    return { resetUrl: config.isProduction ? null : resetUrl, expiresAt: expiresAt.toISOString() };
  },

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const tokenHash = hashOpaqueToken(token);
    const stored = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
    if (!stored || stored.usedAt || stored.expiresAt.getTime() < Date.now()) {
      throw unauthorized('This reset link is invalid or has expired', ERROR_CODES.INVALID_TOKEN);
    }
    await prisma.$transaction([
      prisma.user.update({ where: { id: stored.userId }, data: { passwordHash: await hashPassword(newPassword) } }),
      prisma.passwordResetToken.update({ where: { id: stored.id }, data: { usedAt: new Date() } }),
      prisma.refreshToken.updateMany({ where: { userId: stored.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    logger.info('password reset completed', { userId: stored.userId });
  },

  /** Used by tests + the "danger zone" flow. */
  async deleteAccount(userId: string, password: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw forbidden('Password does not match', 'INVALID_CREDENTIALS');
    }
    // Owning a workspace requires deleting or transferring it first.
    const owned = await prisma.workspace.count({ where: { creatorId: userId, members: { some: { role: 'OWNER' } } } });
    if (owned > 0) {
      throw conflict('Delete or transfer your workspaces before closing your account', 'OWNED_WORKSPACES_EXIST', {
        count: owned,
      });
    }
    await prisma.user.delete({ where: { id: userId } });
  },
};

export const hashForTest = (value: string) => createHash('sha256').update(value).digest('hex');

export { setRefreshCookie, issueSession };
