export interface RequestPayload {
  Get?: string;
  Set?: string;
  SerialNumber: number;
  CommandSource: string;
  [key: string]: unknown;
}

export function buildGet(
  command: string,
  serial: number,
  extra?: Record<string, unknown>
): RequestPayload {
  return {
    Get: command,
    SerialNumber: serial,
    CommandSource: 'Homey',
    ...(extra ?? {}),
  };
}

export function buildSet(
  command: string,
  serial: number,
  extra?: Record<string, unknown>
): RequestPayload {
  return {
    Set: command,
    SerialNumber: serial,
    CommandSource: 'Homey',
    ...(extra ?? {}),
  };
}

export function encodeRequest(payload: unknown): Buffer {
  return Buffer.from(JSON.stringify(payload) + '\n', 'utf-8');
}

const PREVIEW_MAX_CHARS = 200;

// Responses are NOT newline framed: the device streams raw JSON bytes, so we
// must accumulate and retry JSON.parse on the whole buffer every push.
export class JsonAccumulator {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown | null {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      return JSON.parse(this.buffer.toString('utf-8'));
    } catch {
      return null;
    }
  }

  get byteLength(): number {
    return this.buffer.length;
  }

  get preview(): string {
    const text = this.buffer.toString('utf-8');
    return text.length > PREVIEW_MAX_CHARS
      ? `${text.slice(0, PREVIEW_MAX_CHARS)}...`
      : text;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}

const CONTROL_CONTAINER_KEYS = [
  'ControlInfo',
  'GetParameters',
  'Parameters',
] as const;
const DEVICE_MANAGEMENT_CONTAINER_KEYS = [
  'DeviceManagementInfo',
  'ControlInfo',
  'Parameters',
  'GetParameters',
] as const;

// Container-key cascade: firmware is inconsistent about which key wraps the
// register dict, and DeviceManagement has been observed under ControlInfo on
// a JET running 1.4.9.9.9.1.5, verified live. Mandatory, not defensive.
export function unwrapContainer(
  resp: Record<string, unknown> | null | undefined,
  kind: 'control' | 'devicemanagement'
): Record<string, unknown> | null {
  if (!resp) return null;
  const keys =
    kind === 'control'
      ? CONTROL_CONTAINER_KEYS
      : DEVICE_MANAGEMENT_CONTAINER_KEYS;
  for (const key of keys) {
    const value = resp[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return null;
}

// Single access point for register reads. JSON object keys are always
// strings in JS, so no int/string cascade is needed like in Python.
export function readRegister(
  params: Record<string, unknown> | null | undefined,
  reg: string
): string | undefined {
  if (!params) return undefined;
  const value = params[reg];
  if (value === undefined || value === null) return undefined;
  return String(value);
}
