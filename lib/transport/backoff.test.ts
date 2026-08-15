import { describe, expect, it } from 'vitest';
import { Backoff } from './backoff';

describe('Backoff', () => {
  it('starts at zero consecutive failures with a base cooldown', () => {
    const backoff = new Backoff();
    expect(backoff.consecutiveFailures).toBe(0);
    expect(backoff.currentCooldownMs()).toBe(2000);
  });

  it('escalates 2s,4s,8s,16s,32s,60s,60s then resets on success', () => {
    const backoff = new Backoff();
    const observed: number[] = [backoff.currentCooldownMs()];
    for (let i = 0; i < 6; i += 1) {
      backoff.noteFailure();
      observed.push(backoff.currentCooldownMs());
    }
    expect(observed).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(backoff.consecutiveFailures).toBe(6);

    backoff.noteSuccess();
    expect(backoff.consecutiveFailures).toBe(0);
    expect(backoff.currentCooldownMs()).toBe(2000);
  });

  it('honours a custom base and max', () => {
    const backoff = new Backoff(100, 500);
    expect(backoff.currentCooldownMs()).toBe(100);
    backoff.noteFailure();
    expect(backoff.currentCooldownMs()).toBe(200);
    backoff.noteFailure();
    expect(backoff.currentCooldownMs()).toBe(400);
    backoff.noteFailure();
    expect(backoff.currentCooldownMs()).toBe(500);
  });

  it('noteSuccess is a no-op when already healthy', () => {
    const backoff = new Backoff();
    backoff.noteSuccess();
    expect(backoff.consecutiveFailures).toBe(0);
  });
});
