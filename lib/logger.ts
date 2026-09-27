export interface Logger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

// IPv4 address with an optional port, as Node writes it into socket errors.
// Not part of a longer dotted number: firmware versions such as 1.4.9.9.5
// contain four dotted groups and must survive.
const IPV4_WITH_PORT =
  /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d]|\.\d)(?::\d+)?/g;

/**
 * An error as one log-safe phrase. This log reaches diagnostic reports, and
 * the README promises they carry no IP address, so Node's own code
 * (ECONNREFUSED, EHOSTUNREACH) is preferred over its message, which reads
 * "connect ECONNREFUSED 192.168.1.77:8080", and any address left in a
 * message is blanked as a backstop.
 */
export function describeError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code !== '') return code;
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(IPV4_WITH_PORT, '<address>');
}

export const silentLogger: Logger = {
  log(): void {},
  error(): void {},
};
