/**
 * `Promise.all` with a concurrency cap.
 *
 * Aggregate endpoints (the workspace board fans out to one board query per
 * project, analytics runs a dozen grouped counts) would otherwise open one
 * database connection per item and exhaust the pool for everybody else.
 * Errors propagate on the first rejection, like `Promise.all`.
 */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const size = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  };

  await Promise.all(Array.from({ length: size }, worker));
  return results;
}
