/**
 * Round-robin over a list that is too long to process in one tick. Each call takes the next `k` items starting at
 * `cursor` (wrapping), and returns where the following call should start. Discovery cost is then proportional to `k`,
 * not to how many chains exist — adding chains makes each one refresh a little less often instead of making every
 * tick slower (which is what would eventually hit the 60s serverless limit).
 */
export function pickRotation<T>(all: readonly T[], cursor: number, k: number): { picked: T[]; next: number } {
  const n = all.length;
  if (n === 0) return { picked: [], next: 0 };
  if (k <= 0 || k >= n) return { picked: [...all], next: 0 };
  const start = ((Math.floor(cursor) % n) + n) % n;
  const picked: T[] = [];
  for (let i = 0; i < k; i++) picked.push(all[(start + i) % n]);
  return { picked, next: (start + k) % n };
}
