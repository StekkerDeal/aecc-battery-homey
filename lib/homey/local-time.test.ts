import { describe, expect, it } from 'vitest';
import { formatLocalTimestamp } from './local-time';

const ISO_LOCAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

describe('formatLocalTimestamp', () => {
  it('renders a summer instant two hours ahead of UTC in Europe/Amsterdam (CEST)', () => {
    const atMs = Date.parse('2024-07-15T12:00:00Z');

    expect(formatLocalTimestamp(atMs, 'UTC')).toBe('2024-07-15 12:00:00');
    expect(formatLocalTimestamp(atMs, 'Europe/Amsterdam')).toBe(
      '2024-07-15 14:00:00'
    );
  });

  it('renders a winter instant one hour ahead of UTC in Europe/Amsterdam (CET), the reported bug', () => {
    const atMs = Date.parse('2024-01-15T12:00:00Z');

    expect(formatLocalTimestamp(atMs, 'UTC')).toBe('2024-01-15 12:00:00');
    expect(formatLocalTimestamp(atMs, 'Europe/Amsterdam')).toBe(
      '2024-01-15 13:00:00'
    );
  });

  it('always outputs exactly YYYY-MM-DD HH:mm:ss: 19 characters, zero-padded, 24 hour, no T, no Z, no AM/PM', () => {
    const atMs = Date.parse('2024-01-05T03:07:09Z');

    const result = formatLocalTimestamp(atMs, 'Europe/Amsterdam');

    expect(result).toBe('2024-01-05 04:07:09');
    expect(result).toHaveLength(19);
    expect(result).toMatch(ISO_LOCAL_TIMESTAMP);
    expect(result).not.toContain('T');
    expect(result).not.toContain('Z');
    expect(result).not.toMatch(/[AaPp][Mm]/);
  });

  it('renders midnight as 00:00:00, never 24:00:00', () => {
    // 2024-01-15T23:00:00Z is local midnight in Europe/Amsterdam (UTC+1).
    const atMs = Date.parse('2024-01-15T23:00:00Z');

    const result = formatLocalTimestamp(atMs, 'Europe/Amsterdam');

    expect(result).toBe('2024-01-16 00:00:00');
    expect(result).not.toContain('24:00:00');
  });

  it('returns null for a null instant', () => {
    expect(formatLocalTimestamp(null, 'Europe/Amsterdam')).toBeNull();
  });

  it('returns null for a non-finite instant', () => {
    expect(formatLocalTimestamp(NaN, 'Europe/Amsterdam')).toBeNull();
    expect(formatLocalTimestamp(Infinity, 'Europe/Amsterdam')).toBeNull();
    expect(formatLocalTimestamp(-Infinity, 'Europe/Amsterdam')).toBeNull();
  });

  it('falls back to UTC for an invalid or empty timezone instead of throwing', () => {
    const atMs = 1_000;
    const utcResult = formatLocalTimestamp(atMs, 'UTC');

    expect(() => formatLocalTimestamp(atMs, 'Not/AZone')).not.toThrow();
    expect(formatLocalTimestamp(atMs, 'Not/AZone')).toBe(utcResult);

    expect(() => formatLocalTimestamp(atMs, '')).not.toThrow();
    expect(formatLocalTimestamp(atMs, '')).toBe(utcResult);
  });

  it('works for a zone with a non-hour offset, e.g. Asia/Kolkata at UTC+5:30', () => {
    const atMs = Date.parse('2024-01-15T12:00:00Z');

    expect(formatLocalTimestamp(atMs, 'Asia/Kolkata')).toBe(
      '2024-01-15 17:30:00'
    );
  });
});
