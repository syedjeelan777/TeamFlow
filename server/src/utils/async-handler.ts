import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { serialize } from '../lib/serialize.js';

/**
 * Wraps an async route handler so rejected promises reach Express' error
 * middleware instead of hanging the request (Express 5 forwards rejections
 * natively, but this keeps the intent explicit and preserves typed errors).
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    // Never swallow: every rejection is handed to the central error pipeline.
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function ok<T>(res: Parameters<RequestHandler>[1], data: T, status = 200) {
  return res.status(status).json({ success: true as const, data: serialize(data) });
}

export function noContent(res: Parameters<RequestHandler>[1]) {
  return res.status(204).send();
}

export function paginateMeta(page: number, pageSize: number, total: number) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return { page, pageSize, total, totalPages, hasNextPage: page < totalPages };
}
