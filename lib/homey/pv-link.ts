import type { AeccDeviceSettings } from './device-settings';

/**
 * The contract a solar device exposes to the battery device it follows.
 *
 * A solar device holds a second reference on its battery's session, which
 * breaks two things the battery does alone today:
 *
 *  - repair frees the battery's single TCP slot by releasing the session,
 *    but a second reference keeps it polling, so the repair probe fights a
 *    live socket and reports a false failure;
 *  - an address change releases the old key and acquires a new one, so a
 *    follower left holding the old key keeps a dead session alive and never
 *    reaches the new address.
 *
 * Both are fixed by the battery telling its followers to let go before it
 * releases, and to come back after it has acquired again. Declared
 * structurally so lib/ stays free of the Homey SDK.
 */
export interface PvFollower {
  readonly batteryDeviceId: string;
  detachFromBattery(): Promise<void>;
  /**
   * The battery passes the settings it has just bound to. It must, because
   * Homey only persists a settings change after onSettings resolves, so a
   * follower re-reading the battery's settings during a rebind would read
   * the address the battery has just moved away from, acquire a key nobody
   * else holds, and dial it. Omitted only on a follower's own startup,
   * where the stored settings are the current ones.
   */
  attachToBattery(settings?: AeccDeviceSettings): Promise<void>;
}

export function isPvFollower(value: unknown): value is PvFollower {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PvFollower>;
  return (
    typeof candidate.batteryDeviceId === 'string' &&
    typeof candidate.detachFromBattery === 'function' &&
    typeof candidate.attachToBattery === 'function'
  );
}

/**
 * The solar devices following one battery.
 *
 * Takes unknown devices because the caller hands over whatever
 * driver.getDevices() returned, and a device from another driver, or one
 * that predates this contract, must be skipped rather than crash a repair.
 */
export function followersOf(
  devices: readonly unknown[],
  batteryDeviceId: string
): PvFollower[] {
  const followers: PvFollower[] = [];
  for (const device of devices) {
    if (!isPvFollower(device)) continue;
    if (device.batteryDeviceId !== batteryDeviceId) continue;
    followers.push(device);
  }
  return followers;
}
