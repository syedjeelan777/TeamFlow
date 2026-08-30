import type { Request, Response } from 'express';
import { authService, setRefreshCookie } from '../services/auth.service.js';
import { REFRESH_COOKIE } from '../utils/tokens.js';
import { asyncHandler, ok } from '../utils/async-handler.js';
import { config } from '../config/env.js';
import { currentUser } from '../middleware/auth.js';
import { ChangePasswordSchema, LoginSchema, RegisterSchema, ResetPasswordSchema, UpdateProfileSchema } from '../validators/auth.schema.js';
import { ForgotPasswordSchema } from '../validators/auth.schema.js';
import { AppError, ERROR_CODES } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import { bodyOf } from '../validators/common.js';

export const authController = {
  register: [
    validate({ body: RegisterSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      const result = await authService.register(bodyOf(req, RegisterSchema), req.headers['user-agent']);
      setRefreshCookie(res, result.refreshToken, config.refreshTokenTtlMs);
      const { refreshToken, ...publicResult } = result;
      void refreshToken;
      ok(res, publicResult, 201);
    }),
  ],

  login: [
    validate({ body: LoginSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      const result = await authService.login(bodyOf(req, LoginSchema), req.headers['user-agent']);
      setRefreshCookie(res, result.refreshToken, config.refreshTokenTtlMs);
      const { refreshToken, ...publicResult } = result;
      void refreshToken;
      ok(res, publicResult);
    }),
  ],

  refresh: asyncHandler(async (req: Request, res: Response) => {
    const token = req.cookies?.[REFRESH_COOKIE] ?? (typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : '');
    if (!token) throw new AppError(ERROR_CODES.INVALID_TOKEN, 'No active session', 401);
    const result = await authService.refresh(token, req.headers['user-agent']);
    setRefreshCookie(res, result.refreshToken, config.refreshTokenTtlMs);
    const { refreshToken, ...publicResult } = result;
    void refreshToken;
    ok(res, publicResult);
  }),

  logout: asyncHandler(async (req: Request, res: Response) => {
    const token = req.cookies?.[REFRESH_COOKIE] ?? (typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : '');
    await authService.logout(token);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    ok(res, { loggedOut: true });
  }),

  me: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await authService.me(currentUser(req).id));
  }),

  updateProfile: [
    validate({ body: UpdateProfileSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await authService.updateProfile(currentUser(req).id, bodyOf(req, UpdateProfileSchema)));
    }),
  ],

  changePassword: [
    validate({ body: ChangePasswordSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };
      await authService.changePassword(currentUser(req).id, currentPassword, newPassword);
      res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
      ok(res, { passwordChanged: true, reauthenticate: true });
    }),
  ],

  forgotPassword: [
    validate({ body: ForgotPasswordSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      const { email } = req.body as { email: string };
      const result = await authService.forgotPassword(email);
      ok(res, {
        // Never reveal whether the address exists.
        message: 'If that address has an account, a reset link is on its way.',
        ...result,
      });
    }),
  ],

  resetPassword: [
    validate({ body: ResetPasswordSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      const { token, password } = req.body as { token: string; password: string };
      await authService.resetPassword(token, password);
      res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
      ok(res, { passwordReset: true });
    }),
  ],

  deleteAccount: asyncHandler(async (req: Request, res: Response) => {
    const { password } = req.body as { password: string };
    if (!password) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Password confirmation is required', 422);
    await authService.deleteAccount(currentUser(req).id, password);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    ok(res, { deleted: true });
  }),
};
