/** FP-03 circuit breaker: N failures within a window open it for a cool-down; receipts wait (they are not dropped). */
export class CircuitBreaker {
  private failures: number[] = [];
  private openUntil = 0;
  private threshold: number;
  private windowMs: number;
  private coolDownMs: number;
  constructor(threshold = 5, windowMs = 60000, coolDownMs = 60000) {
    this.threshold = threshold;
    this.windowMs = windowMs;
    this.coolDownMs = coolDownMs;
  }
  recordFailure(nowMs: number): void {
    this.failures = this.failures.filter((t) => nowMs - t < this.windowMs);
    this.failures.push(nowMs);
    if (this.failures.length >= this.threshold) { this.openUntil = nowMs + this.coolDownMs; this.failures = []; }
  }
  recordSuccess(): void { this.failures = []; this.openUntil = 0; }
  /** Milliseconds to wait before the next call is allowed (0 = closed). */
  waitMs(nowMs: number): number { return Math.max(0, this.openUntil - nowMs); }
  isOpen(nowMs: number): boolean { return this.waitMs(nowMs) > 0; }
}
