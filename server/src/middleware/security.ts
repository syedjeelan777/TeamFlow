import type { Request } from 'express';
import cors from 'cors';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import helmet from 'helmet';
import type { RequestHandler } from 'express';
import { config } from '../config/env.js';
import { ERROR_CODES, AppError } from '../lib/errors.js';

const origins = config.corsOrigins();
const allowlist: Array<string | RegExp> = origins.map(origin => (origin.startsWith('/') ? new RegExp(origin.slice(1, -1)) : origin));

/** Helmet with a CSP that is safe for a JSON API and lets Socket.IO poll. */
export const securityMiddleware: RequestHandler[] = [
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: config.isProduction ? ["'self'", ...origins.filter(o => typeof o === 'string')] : ["'self'", 'ws:', 'wss:', 'http:', 'https:'],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }),
  cors({
    origin(origin, callback) {
      // Same-origin / server-to-server requests carry no Origin header.
      if (!origin) return callback(null, true);
      const allowed = allowlist.some(entry => (typeof entry === 'string' ? entry === origin : entry.test(origin)));
      if (!allowed) return callback(new Error(`Origin ${origin} is not allowed by CORS`));
      return callback(null, true);
    },
    credentials: true,
    maxAge: 600,
    exposedHeaders: ['X-Request-Id'],
  }),
];

const sharedLimiterOptions = {
  standardHeaders: 'draft-8' as const,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    return req.user?.id ?? ipKeyGenerator(req.ip ?? 'unknown');
  },
  handler: (_req: unknown, _res: unknown, next: (error: unknown) => void) => {
    next(new AppError(ERROR_CODES.RATE_LIMITED, 'Too many requests — please slow down', 429, { retryable: true }));
  },
};

/** Global safety net for the whole API. */
export const apiLimiter = rateLimit({ ...sharedLimiterOptions, windowMs: 60_000, limit: 300 });

/** Credential endpoints: brute-force protection. */
export const authLimiter = rateLimit({ ...sharedLimiterOptions, windowMs: 15 * 60_000, limit: 20 });

/** Login gets its own tighter bucket (plus a longer cool-down window). */
export const loginLimiter = rateLimit({
  ...sharedLimiterOptions,
  windowMs: 15 * 60_000,
  limit: 10,
  skipSuccessfulRequests: true,
});

/** Mutating endpoints (task spam / bot protection). */
export const writeLimiter = rateLimit({ ...sharedLimiterOptions, windowMs: 60_000, limit: 120 });

/** Chat writes are frequent but should still be bounded per user. */
export const messageLimiter = rateLimit({ ...sharedLimiterOptions, windowMs: 60_000, limit: 60 });
