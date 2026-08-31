import { assertPasswordStrength } from '../utils/password.js';
import { z, trimmed } from './common.js';

export const RegisterSchema = z
  .object({
    name: trimmed(2, 60, 'Name'),
    email: z.string().trim().toLowerCase().email('Enter a valid email address').max(160),
    password: z.string().min(1, 'Password is required').superRefine((value, ctx) => {
      try {
        assertPasswordStrength(value);
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: (error as Error).message });
      }
    }),
    workspaceName: trimmed(2, 60, 'Workspace name').optional(),
  })
  .strict();

export const LoginSchema = z
  .object({
    email: z.string().trim().toLowerCase().email('Enter a valid email address'),
    password: z.string().min(1, 'Password is required'),
  })
  .strict();

export const ForgotPasswordSchema = z
  .object({
    email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  })
  .strict();

export const ResetPasswordSchema = z
  .object({
    token: z.string().min(20, 'Reset token is required'),
    password: z.string().min(1, 'Password is required').superRefine((value, ctx) => {
      try {
        assertPasswordStrength(value);
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: (error as Error).message });
      }
    }),
  })
  .strict();

export const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z.string().min(1, 'New password is required').superRefine((value, ctx) => {
      try {
        assertPasswordStrength(value);
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: (error as Error).message });
      }
    }),
  })
  .strict();

export const UpdateProfileSchema = z
  .object({
    name: trimmed(2, 60, 'Name').optional(),
    avatarUrl: z.union([z.string().trim().url('Avatar must be a valid URL'), z.literal('')]).optional(),
    bio: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine(value => Object.keys(value).length > 0, { message: 'Nothing to update' });

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;
export type UpdateProfileInput = z.infer<typeof UpdateProfileSchema>;
