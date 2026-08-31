import type { ErrorRequestHandler, RequestHandler } from 'express';
import { Prisma } from '../generated/prisma/client.js';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError, ERROR_CODES, fromPrismaError } from '../lib/errors.js';

/** 404 handler: nothing matched the route, so answer in the API error shape. */
export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    success: false,
    error: { code: ERROR_CODES.NOT_FOUND, message: `No route matches ${req.method} ${req.baseUrl}${req.path}` },
  });
};

/**
 * Central error translator.
 *
 * Contract: clients receive `{ success: false, error: { code, message, details? } }`.
 * Stack traces and driver messages are logged, never returned, in production.
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  let appError: AppError;

  if (error instanceof AppError) {
    appError = error;
  } else if (error instanceof SyntaxError && 'body' in (error as object)) {
    appError = new AppError(ERROR_CODES.BAD_REQUEST, 'Request body is not valid JSON', 400);
  } else if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const translated = fromPrismaError(error, { 'WorkspaceMember.workspaceId_userId': 'That person is already a member' });
    appError = translated instanceof AppError ? translated : new AppError(ERROR_CODES.CONFLICT, 'That record already exists', 409);
  } else if (error instanceof Prisma.PrismaClientValidationError) {
    appError = new AppError(ERROR_CODES.VALIDATION_ERROR, 'The submitted data is invalid', 422);
  } else if ((error as { code?: string })?.code === 'LIMIT_FILE_SIZE') {
    appError = new AppError(ERROR_CODES.BAD_REQUEST, 'File is too large', 413);
  } else if ((error as { code?: string })?.code === '23505') {
    appError = new AppError(ERROR_CODES.CONFLICT, 'That record already exists', 409);
  } else {
    appError = new AppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 'Something went wrong on our side', 500, { cause: error });
  }

  const logLevel = appError.status >= 500 ? 'error' : 'debug';
  if (logLevel === 'error') {
    logger.error(error, {
      code: appError.code,
      method: req.method,
      path: req.originalUrl,
      userId: (req as { user?: { id: string } }).user?.id,
    });
  } else {
    logger.debug('request rejected', { code: appError.code, status: appError.status, path: req.originalUrl, message: appError.message });
  }

  const body: Record<string, unknown> = { success: false, error: { code: appError.code, message: appError.message } };
  if (appError.details !== undefined) (body.error as Record<string, unknown>).details = appError.details;
  if (!config.isProduction && appError.status >= 500) {
    (body.error as Record<string, unknown>).cause = (appError.cause as Error)?.message ?? undefined;
  }

  res.status(appError.status).json(body);
};
