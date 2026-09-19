// Pure pairing logic for the PV driver, kept out of driver.ts for the same
// reason the battery driver does it: driver.ts mixes `export default class`
// with a `module.exports =` reassignment for Homey's loader, and that
// combination crashes under Vitest the moment anything imports it.

export interface BatteryChoice {
  id: string;
  name: string;
}

// The slice of Homey.Device this module needs, so the tests do not have to
// build a whole SDK device.
export interface BatteryDeviceLike {
  getName(): string;
  getData(): unknown;
}

export interface PvPairDevice {
  name: string;
  data: { id: string };
  store: { batteryDeviceId: string };
}

export interface PairedPvDeviceLike {
  getName(): string;
  getStore(): unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * One row in the "which battery?" list. Returns null for a device whose
 * data carries no usable id, which cannot be linked to and so must not be
 * offered rather than being offered and failing later.
 */
export function toBatteryChoice(
  device: BatteryDeviceLike
): BatteryChoice | null {
  const id = asRecord(device.getData()).id;
  if (typeof id !== 'string' || id === '') return null;
  return { id, name: device.getName() };
}

export function toBatteryChoices(
  devices: readonly BatteryDeviceLike[]
): BatteryChoice[] {
  const choices: BatteryChoice[] = [];
  for (const device of devices) {
    const choice = toBatteryChoice(device);
    if (choice !== null) choices.push(choice);
  }
  return choices;
}

/**
 * Reads the battery id out of what the pair view emitted. Accepts the bare
 * id and the whole choice object, because a view that grows a second field
 * later should not break this handler.
 */
export function parseBatterySelection(data: unknown): string {
  if (typeof data === 'string' && data !== '') return data;
  const id = asRecord(data).id;
  if (typeof id === 'string' && id !== '') return id;
  throw new Error('No battery was selected.');
}

/**
 * The device handed to Homey.
 *
 * Deliberately carries no settings: host, port and brand are read from the
 * linked battery device at runtime, so an address change or a repair there
 * is followed automatically and there is nothing here to drift out of date.
 * That absence is also what keeps the battery driver's host/port collision
 * guard from ever seeing this device, which is correct, since sharing the
 * battery's address is the whole point.
 *
 * The `pv:` prefix on data.id makes Homey's own duplicate check prevent a
 * second PV device for the same battery.
 */
export function buildPvPairDevice(choice: BatteryChoice): PvPairDevice {
  return {
    name: `${choice.name} PV`,
    data: { id: `pv:${choice.id}` },
    store: { batteryDeviceId: choice.id },
  };
}

/** The name of an existing PV device for this battery, or null. */
export function findExistingPvForBattery(
  devices: readonly PairedPvDeviceLike[],
  batteryDeviceId: string
): string | null {
  for (const device of devices) {
    if (asRecord(device.getStore()).batteryDeviceId === batteryDeviceId) {
      return device.getName();
    }
  }
  return null;
}
