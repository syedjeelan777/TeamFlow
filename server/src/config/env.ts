import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// Load .env from the server package first, then fall back to the repository
// root so a single root .env can drive both workspaces.
// this file lives in src/config/ → two levels up is the server package root
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
for (const candidate of [path.join(pkgRoot, '.env'), path.resolve(pkgRoot, '../.env')]) {
  if (existsSync(candidate)) loadDotenv({ path: candidate, quiet: true });
}

/**
 * Environment configuration.
 *
 * Parsing is deliberately strict: a production container that boots with a
 * missing `JWT_SECRET` is a security incident waiting to happen, so we fail
 * fast at startup with a readable message instead.
 */
const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
  CLIENT_URL: z.string().default('http://localhost:5173'),
  ACCESS_TOKEN_TTL_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  REFRESH_TOKEN_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 24 * 60 * 60 * 1000),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).optional(),
  SOCKET_CORS_ORIGIN: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).optional(),
  SERVE_CLIENT: booleanish.default(false),
});

export type AppEnv = z.infer<typeof EnvSchema>;

function load(): AppEnv {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill in the values.`);
  }
  const env = parsed.data;
  const isProd = env.NODE_ENV === 'production';
  if (isProd && (env.JWT_SECRET.startsWith('replace-me') || env.JWT_REFRESH_SECRET.startsWith('replace-me'))) {
    throw new Error('Refusing to start in production with the example JWT secrets.');
  }
  return env;
}

export const env = load();

export const config = {
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  isDevelopment: env.NODE_ENV === 'development',
  port: env.PORT,
  clientUrl: env.CLIENT_URL,
  /** Extra origins allowed to call the API / open a socket (comma separated). */
  extraCorsOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  accessTokenTtlMs: env.ACCESS_TOKEN_TTL_MS,
  refreshTokenTtlMs: env.REFRESH_TOKEN_TTL_MS,
  bcryptRounds: env.BCRYPT_ROUNDS ?? (env.NODE_ENV === 'production' ? 12 : 10),
  logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'silent' : 'info'),
  serveClient: env.SERVE_CLIENT || env.NODE_ENV === 'production',
  /** Absolute path of the built client, served by Express when `serveClient`. */
  clientDistPath: process.env.CLIENT_DIST_PATH ?? '../client/dist',
  corsOrigins: () => {
    // Same-origin dev traffic (Vite proxies /api and /socket.io) carries no
    // cross-origin risk; anything else must be listed explicitly.
    const origins = new Set<string>([env.CLIENT_URL, 'http://localhost:5173', ...config.extraCorsOrigins]);
    if (process.env.SOCKET_CORS_ORIGIN) origins.add(process.env.SOCKET_CORS_ORIGIN);
    return [...origins].filter(Boolean);
  },
  jwt: {
    accessSecret: env.JWT_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
  },
} as const;

export type Config = typeof config;
