import type { RequestHandler } from 'express';
import { ZodError, type ZodTypeAny } from 'zod';
import { AppError, ERROR_CODES } from '../lib/errors.js';

interface Schemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Zod validation middleware.
 *
 * Parsed (and therefore coerced/trimmed/stripped) values replace the raw
 * request properties, so controllers only ever see validated input. Unknown
 * keys are stripped by Zod's default object behaviour — that is our guard
 * against mass-assignment style bugs.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params) as never;
      if (schemas.query) {
        const original = req.query as Record<string, unknown>;
        (req as { originalQuery?: Record<string, unknown> }).originalQuery = original;
        const parsed = schemas.query.parse(original);
        // Express 5 exposes req.query as a getter; assigning a parsed object is
        // safe because we replace the whole property on the request instance.
        Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true });
      }
      if (schemas.body) {
        const original = req.body as unknown;
        (req as { originalBody?: unknown }).originalBody = original;
        req.body = schemas.body.parse(original);
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(
          new AppError(ERROR_CODES.VALIDATION_ERROR, 'The submitted data is invalid', 422, {
            details: error.issues.map(issue => ({
              path: issue.path.join('.') || '(root)',
              message: issue.message,
              code: issue.code,
            })),
          }),
        );
        return;
      }
      next(error);
    }
  };
}
