const DEFAULT_BASE_MS = 2000;
const DEFAULT_MAX_MS = 60000;

// Reconnect cooldown escalation: base * 2^failures, capped at max. Read the
// cooldown before calling noteFailure() so the first failure of an outage
// waits exactly base, matching the ported Python client's behaviour.
export class Backoff {
  private failures = 0;

  constructor(
    private readonly baseMs: number = DEFAULT_BASE_MS,
    private readonly maxMs: number = DEFAULT_MAX_MS
  ) {}

  get consecutiveFailures(): number {
    return this.failures;
  }

  currentCooldownMs(): number {
    return Math.min(this.baseMs * 2 ** this.failures, this.maxMs);
  }

  noteFailure(): void {
    this.failures += 1;
  }

  noteSuccess(): void {
    this.failures = 0;
  }
}
