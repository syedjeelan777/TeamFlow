import bcrypt from 'bcryptjs';
import { config } from '../config/env.js';
import { AppError, ERROR_CODES } from '../lib/errors.js';

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, config.bcryptRounds);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch (error) {
    // A malformed hash in the DB must surface loudly, not look like a wrong password.
    throw new AppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 'Password verification failed', 500, { cause: error });
  }
}

const COMMON_PASSWORDS = new Set(['password', 'password1', '12345678', 'qwerty123', 'letmein1', 'teamflow1']);

/**
 * Password policy: ≥ 10 characters, not a known-breached pattern. We do not
 * force character classes (research shows that hurts more than it helps) but we
 * do reject obvious dictionary passwords.
 */
export function assertPasswordStrength(password: string): void {
  if (password.length < 10) {
    throw new AppError(ERROR_CODES.PASSWORD_TOO_WEAK, 'Password must be at least 10 characters long', 422, {
      details: [{ path: 'password', message: 'Use at least 10 characters.' }],
    });
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    throw new AppError(ERROR_CODES.PASSWORD_TOO_WEAK, 'That password is too common — pick something harder to guess', 422, {
      details: [{ path: 'password', message: 'Password appears in known breach lists.' }],
    });
  }
}
