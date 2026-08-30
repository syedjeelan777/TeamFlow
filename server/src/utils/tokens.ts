import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { config } from '../config/env.js';
import { AppError, ERROR_CODES } from '../lib/errors.js';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  name: string;
  /** Session id (refresh token row id) — ties an access token to a session. */
  sid: string;
  type: 'access';
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  type: 'refresh';
}

const ISSUER = 'teamflow';
const AUDIENCE = 'teamflow:api';

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function signAccessToken(payload: Omit<AccessTokenPayload, 'type'>): { token: string; expiresAt: Date } {
  const expiresAt = new Date(Date.now() + config.accessTokenTtlMs);
  const token = jwt.sign({ ...payload, type: 'access' }, config.jwt.accessSecret, {
    expiresIn: Math.floor(config.accessTokenTtlMs / 1000),
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  return { token, expiresAt };
}

export function signRefreshToken(payload: { sub: string; jti: string }): { token: string; expiresAt: Date } {
  const expiresAt = new Date(Date.now() + config.refreshTokenTtlMs);
  const token = jwt.sign({ ...payload, type: 'refresh' }, config.jwt.refreshSecret, {
    expiresIn: Math.floor(config.refreshTokenTtlMs / 1000),
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  return { token, expiresAt };
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, config.jwt.accessSecret, { issuer: ISSUER, audience: AUDIENCE }) as JwtPayload &
      Partial<AccessTokenPayload>;
    if (decoded.type !== 'access' || typeof decoded.sub !== 'string') {
      throw new AppError(ERROR_CODES.INVALID_TOKEN, 'Malformed access token', 401);
    }
    return decoded as AccessTokenPayload;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if ((error as Error).name === 'TokenExpiredError') {
      throw new AppError(ERROR_CODES.TOKEN_EXPIRED, 'Access token expired', 401);
    }
    throw new AppError(ERROR_CODES.INVALID_TOKEN, 'Invalid access token', 401);
  }
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  try {
    const decoded = jwt.verify(token, config.jwt.refreshSecret, { issuer: ISSUER, audience: AUDIENCE }) as JwtPayload &
      Partial<RefreshTokenPayload>;
    if (decoded.type !== 'refresh' || typeof decoded.sub !== 'string' || typeof decoded.jti !== 'string') {
      throw new AppError(ERROR_CODES.INVALID_TOKEN, 'Malformed refresh token', 401);
    }
    return decoded as RefreshTokenPayload;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if ((error as Error).name === 'TokenExpiredError') {
      throw new AppError(ERROR_CODES.TOKEN_EXPIRED, 'Session expired, please sign in again', 401);
    }
    throw new AppError(ERROR_CODES.INVALID_TOKEN, 'Invalid refresh token', 401);
  }
}

/**
 * Refresh tokens are stored as HMAC-SHA256 digests, so a database leak does not
 * hand over usable session tokens (they are random JWTs, not passwords, but the
 * same principle applies).
 */
export function hashToken(token: string): string {
  return createHmac('sha256', config.jwt.refreshSecret).update(token).digest('hex');
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function randomToken(bytes = 32): string {
  return base64Url(randomBytes(bytes));
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export const REFRESH_COOKIE = 'tf_refresh';

export function refreshCookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.isProduction,
    path: '/api/auth',
    maxAge: maxAgeMs,
  };
}
