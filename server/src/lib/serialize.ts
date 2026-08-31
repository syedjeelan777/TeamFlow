import type { PublicUser } from '@teamflow/shared';

/** Serialises Dates → ISO strings and BigInt → string, recursively. */
export function serialize<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, val) => {
      if (typeof val === 'bigint') return val.toString();
      if (val instanceof Date) return val.toISOString();
      return val;
    }),
  ) as T;
}

type UserLike = {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string | null;
  bio?: string | null;
  createdAt?: Date;
  lastSeenAt?: Date | null;
};

/**
 * The only user shape ever returned by the API — `passwordHash` is structurally
 * absent here, which is what keeps us from leaking it by accident.
 */
export function publicUser(user: UserLike): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl ?? null,
    bio: user.bio ?? null,
    createdAt: (user.createdAt ?? new Date(0)).toISOString(),
    ...(user.lastSeenAt !== undefined ? { lastSeenAt: user.lastSeenAt ? user.lastSeenAt.toISOString() : null } : {}),
  };
}

/** `select` fragment reused by every query that embeds a user object. */
export const publicUserSelect = {
  id: true,
  email: true,
  name: true,
  avatarUrl: true,
  bio: true,
  createdAt: true,
  lastSeenAt: true,
} as const;

/** Compact project/user fragment for task cards. */
export const minimalUserSelect = { id: true, name: true, avatarUrl: true } as const;
