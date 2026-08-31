import { config } from './env.js';

type Level = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * Minimal structured JSON logger.
 *
 * We intentionally avoid a logging framework: every line is a single JSON
 * object (machine-parseable in production log pipelines) and the API surface
 * is four functions. Redaction of secrets is handled by `redact`.
 */
const SENSITIVE_KEYS = /^(password|passwordhash|token|tokenhash|authorization|cookie|secret|refreshToken|accessToken)$/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.test(key) ? '[redacted]' : redact(val, depth + 1);
  }
  return out;
}

function emit(level: Level, message: string, meta?: Record<string, unknown>) {
  if (ORDER[level] < ORDER[config.logLevel as Level]) return;
  const line = {
    time: new Date().toISOString(),
    level,
    msg: message,
    ...(meta ? { meta: redact(meta) } : {}),
  };
  const serialized = JSON.stringify(line, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v));
  if (level === 'error' || level === 'warn') process.stderr.write(`${serialized}\n`);
  else process.stdout.write(`${serialized}\n`);
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => emit('debug', message, meta),
  info: (message: string, meta?: Record<string, unknown>) => emit('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit('warn', message, meta),
  /** Always logs at `error` — unexpected failures must never be swallowed. */
  error: (error: unknown, context?: Record<string, unknown>) => {
    const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : JSON.stringify(error));
    emit('error', err.message, { stack: err.stack, ...context });
  },
};

export type Logger = typeof logger;
