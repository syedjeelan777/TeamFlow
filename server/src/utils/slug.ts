/** URL-safe slug, with transliteration of accents and collision suffixes. */
export function slugify(input: string, fallback = 'workspace'): string {
  const base = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base.length >= 2 ? base : fallback;
}

export async function uniqueSlug(
  desired: string,
  exists: (slug: string) => Promise<boolean>,
  maxLength = 60,
): Promise<string> {
  let candidate = desired.slice(0, maxLength);
  let attempt = 2;
  // Fast path first; only widen on collision.
  while (await exists(candidate)) {
    const suffix = `-${attempt}`;
    candidate = `${desired.slice(0, maxLength - suffix.length)}${suffix}`;
    attempt += 1;
    if (attempt > 500) {
      candidate = `${desired.slice(0, maxLength - 9)}-${Date.now().toString(36)}`;
      break;
    }
  }
  return candidate;
}

const AVATAR_COLORS = ['indigo', 'violet', 'sky', 'emerald', 'amber', 'rose', 'teal', 'slate'];

/** Deterministic palette pick so a user's avatar colour never flickers. */
export function colorFromString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] as string;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase() ?? '')
    .join('');
}
