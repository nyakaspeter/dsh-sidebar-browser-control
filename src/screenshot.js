// Capture failures are terminal for this tab until an explicit user-requested retry.
export class ScreenshotGuard {
  constructor(timeoutMs = 5000) {
    this.timeoutMs = timeoutMs;
    this.blocked = new Map();
  }
  async capture(key, { visible, capture, signal, retry = false }) {
    signal?.throwIfAborted();
    if (retry) this.blocked.delete(key);
    if (this.blocked.has(key)) return this.blocked.get(key);
    const fail = (reason) => {
      const result = {
        ok: false,
        code: 'SCREENSHOT_UNAVAILABLE',
        retryable: false,
        reason,
        message:
          'Screenshot unavailable. Hidden or minimized DSH windows may not provide a capture surface; capture can also fail while visible. This does not mean browsing is unavailable. Do not retry, poll, restart DSH, or try alternative capture APIs. Continue with read/evaluate and DOM inspection. If visual inspection is essential, tell the user to restore DSH and explicitly request another screenshot; only then use retryScreenshot:true.',
      };
      this.blocked.set(key, result);
      return result;
    };
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      if (!(await visible(bounded)))
        return fail('DSH window is hidden or minimized.');
      const result = await capture(bounded);
      if (!result?.data) return fail('Capture returned no image.');
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      return fail(
        timeout.aborted
          ? 'Capture exceeded the five-second limit.'
          : String(error.message ?? error),
      );
    }
  }
  clear(key) {
    this.blocked.delete(key);
  }
}
