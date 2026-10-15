// Bounds estimated in-flight file payloads, not the process's total heap.
// Encryption and platform transports can hold additional copies of a payload.
export class SyncTransferBudget {
  private used = 0;
  private waiting: (() => void)[] = [];
  constructor(private readonly limit = 64 * 1024 * 1024) {}
  async run<T>(estimatedBytes: number, operation: () => Promise<T>): Promise<T> {
    const weight = Math.min(this.limit, Math.max(0, estimatedBytes));
    await new Promise<void>(resolve => {
      const acquire = () => {
        if (this.used + weight > this.limit) return false;
        this.used += weight;
        resolve();
        return true;
      };
      if (!this.waiting.length && acquire()) return;
      this.waiting.push(() => { if (acquire()) this.waiting.shift(); });
    });
    try { return await operation(); }
    finally {
      this.used -= weight;
      while (this.waiting.length) {
        const before = this.waiting.length;
        this.waiting[0]();
        if (this.waiting.length === before) break;
      }
    }
  }
}
