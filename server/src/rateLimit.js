// Counts attempts per key (an IP address or an email) in fixed time windows, in memory.
// Fine for one API instance; with several, the counts would need a shared store such
// as Redis, or each instance would allow the full limit on its own.
export class RateLimiter {
  #windows = new Map(); // key -> { count, resetAt }

  constructor({ limit, windowMs }) {
    this.limit = limit;
    this.windowMs = windowMs;
    // Drop finished windows now and then, so memory doesn't grow with every IP seen.
    setInterval(() => {
      const now = Date.now();
      for (const [key, window] of this.#windows) if (window.resetAt <= now) this.#windows.delete(key);
    }, windowMs).unref();
  }

  // Seconds until `key` may try again, or 0 if it is under the limit.
  retryAfter(key) {
    const window = this.#current(key);
    return window && window.count >= this.limit ? Math.ceil((window.resetAt - Date.now()) / 1000) : 0;
  }

  // Counts one attempt for `key`.
  hit(key) {
    let window = this.#current(key);
    if (!window) {
      window = { count: 0, resetAt: Date.now() + this.windowMs };
      this.#windows.set(key, window);
    }
    window.count++;
  }

  reset(key) {
    this.#windows.delete(key);
  }

  #current(key) {
    const window = this.#windows.get(key);
    if (window && window.resetAt <= Date.now()) {
      this.#windows.delete(key);
      return null;
    }
    return window ?? null;
  }
}
