/**
 * Structured application errors.
 *
 * Every error that can reach an HTTP response is an `AppError` (or is wrapped
 * into one by the error middleware), which guarantees the documented wire
 * format:
 *
 * ```json
 * { "success": false, "error": { "code": "TASK_NOT_FOUND", "message": "…", "details": [] } }
 * ```
 */
export const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  BAD_REQUEST: 'BAD_REQUEST',
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
  // Domain-specific codes (stable contract for the client).
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  PASSWORD_TOO_WEAK: 'PASSWORD_TOO_WEAK',
  WORKSPACE_NOT_FOUND: 'WORKSPACE_NOT_FOUND',
  NOT_A_MEMBER: 'NOT_A_MEMBER',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  COMMENT_NOT_FOUND: 'COMMENT_NOT_FOUND',
  CHANNEL_NOT_FOUND: 'CHANNEL_NOT_FOUND',
  MESSAGE_NOT_FOUND: 'MESSAGE_NOT_FOUND',
  LAST_OWNER: 'LAST_OWNER',
} as const;

export type ErrorCode = (keyof typeof ERROR_CODES) | (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  /** Errors are not retryable by default; auth-refresh flows flip this. */
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    status = 400,
    options: { details?: unknown; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
    Error.captureStackTrace?.(this, AppError);
  }

  toJSON() {
    return {
      success: false as const,
      error: { code: this.code, message: this.message, ...(this.details !== undefined ? { details: this.details } : {}) },
    };
  }
}

export const badRequest = (message: string, code = ERROR_CODES.BAD_REQUEST, details?: unknown) =>
  new AppError(code, message, 400, { details });

export const unauthorized = (message = 'Authentication required', code: string = ERROR_CODES.UNAUTHORIZED) =>
  new AppError(code, message, 401);

export const forbidden = (message = 'You do not have access to this resource', code: string = ERROR_CODES.PERMISSION_DENIED) =>
  new AppError(code, message, 403);

export const notFound = (message: string, code: string = ERROR_CODES.NOT_FOUND) => new AppError(code, message, 404);

export const conflict = (message: string, code: string = ERROR_CODES.CONFLICT, details?: unknown) =>
  new AppError(code, message, 409, { details });

export const internalError = (message = 'Something went wrong on our side', cause?: unknown) =>
  new AppError(ERROR_CODES.INTERNAL_SERVER_ERROR, message, 500, { cause });

/** Normalises anything thrown by Prisma into a meaningful AppError. */
export function fromPrismaError(error: unknown, conflicts: Record<string, string> = {}): unknown {
  const err = error as { code?: string; meta?: { target?: unknown } };
  if (err?.code === 'P2002') {
    const target = Array.isArray(err.meta?.target) ? (err.meta.target as string[]).join(', ') : String(err.meta?.target ?? 'value');
    return conflict(conflicts[target] ?? `A record with this ${target} already exists`, ERROR_CODES.CONFLICT, { target });
  }
  if (err?.code === 'P2025') return notFound('The requested record no longer exists');
  if (err?.code === 'P2003') return badRequest('Related record does not exist');
  return error;
}
