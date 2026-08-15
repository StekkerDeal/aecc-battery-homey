export interface Logger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export const silentLogger: Logger = {
  log(): void {},
  error(): void {},
};
