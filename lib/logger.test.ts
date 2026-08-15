import { describe, expect, it } from 'vitest';
import { silentLogger } from './logger';

describe('silentLogger', () => {
  it('exposes a log method that does nothing observable', () => {
    expect(() => silentLogger.log('anything', 1, { a: 1 })).not.toThrow();
  });

  it('exposes an error method that does nothing observable', () => {
    expect(() => silentLogger.error('anything', 1, { a: 1 })).not.toThrow();
  });

  it('returns undefined from both methods', () => {
    expect(silentLogger.log('x')).toBeUndefined();
    expect(silentLogger.error('x')).toBeUndefined();
  });
});
