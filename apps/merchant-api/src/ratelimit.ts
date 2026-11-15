/** Fixed-window, in-memory limiter (one process; see docs/merchant/OPERATIONS.md for scaling). */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(private limit: number, private windowMs: number) {}
  /** Returns remaining requests, or -1 when over the limit. */
  hit(key: string, now = Date.now()): number {
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      w = { start: now, count: 0 };
      this.windows.set(key, w);
      if (this.windows.size > 100_000) this.sweep(now);
    }
    w.count++;
    return w.count > this.limit ? -1 : this.limit - w.count;
  }
  resetMs(key: string, now = Date.now()) {
    const w = this.windows.get(key);
    return w ? Math.max(0, this.windowMs - (now - w.start)) : 0;
  }
  private sweep(now: number) {
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
  }
  get max() { return this.limit; }
}
