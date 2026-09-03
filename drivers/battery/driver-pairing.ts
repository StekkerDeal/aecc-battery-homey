// Pure pairing-flow logic for the battery driver, split out of driver.ts so
// it can be unit tested: driver.ts mixes `export default class` with a
// `module.exports =` reassignment for the real Homey CJS loader, and that
// combination crashes under Vitest's ESM transform the moment anything
// imports the file. Keeping this module free of that pattern lets
// driver.test.ts exercise the actual pairing logic instead of skipping it.
import type Homey from 'homey';
import { parseEnergyFrame } from '../../lib/protocol/telemetry';
import { MAX_REGISTER_POWER_DEFAULT } from '../../lib/protocol/registers';
import type { BrandId, DeviceIdentity } from '../../lib/types';

const DEFAULT_PORT = 8080;

const BRAND_IDS: readonly BrandId[] = [
  'lunergy',
  'sunpura',
  'voltdeer',
  'aeg',
  'aferiy',
  'accumate',
  'jet',
  'oscal',
  'fossibot',
  'other',
];

function isBrandId(value: string): value is BrandId {
  return (BRAND_IDS as readonly string[]).includes(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function toPositiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : fallback;
}

interface PairListDeviceSettings {
  host: string;
  port: number;
  brand?: BrandId;
  model?: string;
  firmware?: string;
  max_charge_power?: number;
  max_discharge_power?: number;
}

// The shape handed to Homey's pairing socket, and mirrored back by
// list_devices_selection for the discovery path.
export interface PairListDevice {
  name: string;
  data: { id: string };
  store: { serial: string | null };
  settings: PairListDeviceSettings;
}

export function buildDeviceName(
  serial: string | null,
  addressOrHost: string
): string {
  return `AECC battery ${serial ?? addressOrHost}`;
}

export function resolvePort(txt: Record<string, unknown>): number {
  // s_port carries the real protocol port (8080). The mDNS record's own
  // port field is the device's web UI on 80 and must never be used.
  const raw = txt.s_port;
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) return Number(raw);
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  return DEFAULT_PORT;
}

export function resolveHost(
  txt: Record<string, unknown>,
  address: string
): string {
  const raw = txt.s_ip;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : address;
}

export function resolveSerial(txt: Record<string, unknown>): string | null {
  const raw = txt.s_sn;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

export function isMdnsSdResult(
  result:
    | Homey.DiscoveryResultMDNSSD
    | Homey.DiscoveryResultSSDP
    | Homey.DiscoveryResultMAC
): result is Homey.DiscoveryResultMDNSSD {
  return 'txt' in result;
}

export function mapDiscoveryResultToPairDevice(
  result: Homey.DiscoveryResultMDNSSD
): PairListDevice {
  const txt = asRecord(result.txt);
  const port = resolvePort(txt);
  const host = resolveHost(txt, result.address);
  const serial = resolveSerial(txt);
  const id = serial ?? `${host}:${port}`;
  return {
    name: buildDeviceName(serial, result.address),
    data: { id },
    store: { serial },
    settings: { host, port },
  };
}

export interface ManualConnectPayload {
  host: string;
  port: number;
  name: string;
}

// manual_entry.html already rejects an empty host before emitting, so this
// stays lenient rather than throwing on a malformed payload.
export function parseManualConnectPayload(data: unknown): ManualConnectPayload {
  const record = asRecord(data);
  const host = typeof record.host === 'string' ? record.host.trim() : '';
  const port = toPositiveInt(record.port, DEFAULT_PORT);
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  return { host, port, name };
}

export interface SetBrandPayload {
  brand: BrandId;
  model: string;
  maxChargePowerW: number;
  maxDischargePowerW: number;
}

export function parseSetBrandPayload(data: unknown): SetBrandPayload {
  const record = asRecord(data);
  const brandRaw = record.brand;
  const brand: BrandId =
    typeof brandRaw === 'string' && isBrandId(brandRaw) ? brandRaw : 'other';
  const model = typeof record.model === 'string' ? record.model.trim() : '';
  const maxChargePowerW = toPositiveInt(
    record.max_charge_power,
    MAX_REGISTER_POWER_DEFAULT
  );
  const maxDischargePowerW = toPositiveInt(
    record.max_discharge_power,
    MAX_REGISTER_POWER_DEFAULT
  );
  return { brand, model, maxChargePowerW, maxDischargePowerW };
}

export function buildManualPairDevice(
  payload: ManualConnectPayload,
  identity: DeviceIdentity | null
): PairListDevice {
  const serial = identity?.serial ?? null;
  const id = serial ?? `${payload.host}:${payload.port}`;
  const name =
    payload.name !== '' ? payload.name : buildDeviceName(serial, payload.host);
  const settings: PairListDeviceSettings = {
    host: payload.host,
    port: payload.port,
  };
  if (identity?.model !== undefined) settings.model = identity.model;
  if (identity?.firmware !== undefined) settings.firmware = identity.firmware;
  return { name, data: { id }, store: { serial }, settings };
}

// Applies choose_brand's collected fields onto a pending device. An empty
// typed model keeps whatever the identity probe already found, if any.
export function applyBrandSettings(
  device: PairListDevice,
  payload: SetBrandPayload
): PairListDevice {
  const settings: PairListDeviceSettings = {
    ...device.settings,
    brand: payload.brand,
    max_charge_power: payload.maxChargePowerW,
    max_discharge_power: payload.maxDischargePowerW,
  };
  if (payload.model !== '') settings.model = payload.model;
  return { ...device, settings };
}

// list_devices_selection's payload shape is not documented; this accepts
// either full device objects (as returned by our own list_devices handler)
// or bare id strings, single or array.
export function extractSelectedIds(data: unknown): string[] {
  const items = Array.isArray(data) ? data : [data];
  const ids: string[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      ids.push(item);
      continue;
    }
    const nested = asRecord(asRecord(item).data);
    if (typeof nested.id === 'string') ids.push(nested.id);
  }
  return ids;
}

export function extractSelectedDevices(
  data: unknown,
  cache: ReadonlyMap<string, PairListDevice>
): PairListDevice[] {
  const devices: PairListDevice[] = [];
  for (const id of extractSelectedIds(data)) {
    const cached = cache.get(id);
    if (cached) devices.push(cached);
  }
  return devices;
}

export interface PairedDeviceLike {
  getName(): string;
  getSettings(): unknown;
}

// Homey only dedupes pairing on data.id, which misses a serial-based id
// from a discovered pairing colliding with a host:port from a manual one.
export function findHostPortCollision(
  devices: readonly PairedDeviceLike[],
  host: string,
  port: number
): string | null {
  for (const device of devices) {
    const settings = asRecord(device.getSettings());
    if (settings.host === host && settings.port === port) {
      return device.getName();
    }
  }
  return null;
}

export interface ProbeClientLike {
  connect(): Promise<void>;
  getEnergyParameters(): Promise<Record<string, unknown> | null>;
  getDeviceIdentity(): Promise<DeviceIdentity | null>;
  disconnect(): Promise<void>;
}

export type ProbeOutcome =
  | { ok: true; identity: DeviceIdentity | null }
  | { ok: false; reason: 'connect_failed' | 'no_valid_data' };

// The battery serves one TCP session at a time, so the probe socket is
// always closed here regardless of outcome, never left open for the
// device's first real poll to fight over.
export async function runConnectionProbe(
  client: ProbeClientLike
): Promise<ProbeOutcome> {
  try {
    try {
      await client.connect();
    } catch {
      return { ok: false, reason: 'connect_failed' };
    }

    const raw = await client.getEnergyParameters();
    const frame = raw !== null ? parseEnergyFrame(raw) : null;
    if (frame === null) {
      return { ok: false, reason: 'no_valid_data' };
    }

    // Lunergy has no DeviceManagement support and times out here by
    // design, so identity failure must never block pairing.
    let identity: DeviceIdentity | null = null;
    try {
      identity = await client.getDeviceIdentity();
    } catch {
      identity = null;
    }

    return { ok: true, identity };
  } finally {
    await client.disconnect();
  }
}
