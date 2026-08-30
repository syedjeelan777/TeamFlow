import { z } from 'zod';

/** UUID param validation — also used to keep Socket.IO room ids honest. */
export const uuid = z.string().uuid('Must be a valid id');
export const uuidParam = z.object({ id: uuid });
export const workspaceIdParam = z.object({ workspaceId: uuid });
export const projectIdParam = z.object({ projectId: uuid });
export const taskIdParam = z.object({ taskId: uuid });

export const trimmed = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .min(min, `${label} must be at least ${min} characters`)
    .max(max, `${label} must be at most ${max} characters`);

export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal('').transform(() => null));

/** Accepts ISO strings or date-only strings; always returns a Date. */
export const dateField = z
  .union([z.string(), z.date()])
  .transform((value, ctx) => {
    if (value instanceof Date) return value;
    const parsed = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
    if (Number.isNaN(parsed.getTime())) {
      ctx.addIssue({ code: 'custom', message: 'Invalid date' });
      return z.NEVER;
    }
    return parsed;
  })
  .nullable()
  .optional();

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * A boolean expressed in a query string.
 *
 * It also accepts a real boolean so a route can be re-parsed defensively after
 * `validate()` already replaced `req.query` with its parsed output.
 */
export const booleanFlag = z
  .union([z.enum(['true', 'false', '1', '0']), z.boolean()])
  .transform(v => v === true || v === 'true' || v === '1');

/** Same as `booleanFlag` but defaults to `false` when absent. */
export const booleanFlagDefault = booleanFlag.default(false);

export { z };

import type { Request } from 'express';

/**
 * Typed accessors for validated input.
 *
 * `validate()` runs first and replaces `req.query` / `req.body` with its parsed
 * output, which is *not* necessarily re-parseable (a transformed boolean or a
 * comma-split array are already in their final shape). So we parse the raw
 * value and fall back to whatever the middleware produced. A route that forgot
 * `validate()` therefore still fails loudly, on raw input.
 */
function parseOrUseParsed(raw: unknown, parsed: unknown, schema: { parse: (value: unknown) => unknown }) {
  try {
    return schema.parse(raw) as never;
  } catch {
    return parsed as never;
  }
}

export function bodyOf<T>(req: Request & { body?: unknown }, schema: { parse: (value: unknown) => T }): T {
  const value = req.body ?? {};
  return parseOrUseParsed(value, value, schema) as T;
}

export function queryOf<T>(
  req: Request & { originalQuery?: Record<string, unknown>; query: unknown },
  schema: { parse: (value: unknown) => T },
): T {
  const raw = req.originalQuery ?? req.query;
  return parseOrUseParsed(raw, req.query, schema) as T;
}
