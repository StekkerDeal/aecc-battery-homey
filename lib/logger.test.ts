import { describe, expect, it } from 'vitest';
import { describeError, silentLogger } from './logger';

// The app log reaches diagnostic reports, which promise no IP address.
describe('describeError', () => {
  it("prefers Node's error code over a message that carries the address", () => {
    const err = Object.assign(
      new Error('connect ECONNREFUSED 192.168.1.77:8080'),
      { code: 'ECONNREFUSED' }
    );
    expect(describeError(err)).toBe('ECONNREFUSED');
  });

  it('blanks an address left in a message without a code', () => {
    expect(describeError(new Error('no route to 10.0.0.5:8080 today'))).toBe(
      'no route to <address> today'
    );
    expect(describeError('lost 192.168.1.77')).toBe('lost <address>');
  });

  it('leaves a firmware version with four or more dotted groups alone', () => {
    expect(describeError('unsupported firmware 1.4.9.9.5')).toBe(
      'unsupported firmware 1.4.9.9.5'
    );
    expect(describeError('lost 192.168.1.77.')).toBe('lost <address>.');
  });

  it('passes a plain message through unchanged', () => {
    expect(describeError(new Error('read timeout after 400ms'))).toBe(
      'read timeout after 400ms'
    );
    expect(describeError(null)).toBe('null');
  });
});

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
