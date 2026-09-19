/**
 * Renders a timestamp for the "Last update" sensor.
 *
 * This used to emit an ISO string, which is UTC. Homey prints a string
 * capability verbatim, so every user outside UTC read a clock that was
 * wrong by their offset: two hours behind in the Netherlands in summer,
 * one in winter. It reads as the battery's clock drifting, which is why it
 * was reported as a hardware problem rather than a display one.
 *
 * The format is deliberately `YYYY-MM-DD HH:mm:ss`: sortable, identical in
 * both languages the app ships, and free of AM/PM ambiguity.
 */
export function formatLocalTimestamp(
  atMs: number | null,
  timeZone: string
): string | null {
  if (atMs === null || !Number.isFinite(atMs)) return null;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(atMs));

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find(part => part.type === type)?.value ?? '';

  // Hour can come back as "24" at midnight in some runtimes with hour12
  // false, which is a valid ISO 8601 hour but not one anybody wants to see.
  const hour = get('hour') === '24' ? '00' : get('hour');

  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}:${get('second')}`;
}

/**
 * Falls back to UTC for a zone Intl will not accept. A device that cannot
 * tell the time is worse than one showing the wrong zone, and a Homey with
 * an unset or exotic timezone should not make the sensor throw on every
 * poll.
 */
function safeTimeZone(timeZone: string): string {
  if (!timeZone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}
