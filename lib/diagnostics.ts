import type { BrandId } from './types';
import { describeError } from './logger';
import { ResponseShapeError } from './protocol/frames';
import { BRAND_LABELS, getBrandProfile } from './protocol/brands';
import type { WorkMode } from './protocol/control';
import {
  REG_AI_SMART_CHARGE,
  REG_AI_SMART_DISC,
  REG_CONTROL_TIME1,
  REG_CUSTOM_MODE,
  REG_EMS_ENABLE,
  REG_MAX_FEED_POWER,
  REG_MAX_SOC,
  REG_MIN_SOC,
  REG_SCHEDULE_MODE,
} from './protocol/registers';
import {
  directionOf,
  type SessionDiagnosticsState,
  type SessionSnapshot,
  type WriteHistoryEntry,
} from './session';

/**
 * The diagnostics dump behind the battery's "Write diagnostics to log"
 * button. Homey's own "Send diagnostic report" carries only the app log,
 * so the dump is written there as one line and reaches us with the report.
 *
 * The shape is the Home Assistant integration's diagnostics download
 * (aecc-battery-local, custom_components/aecc_battery/diagnostics.py), key
 * for key, so the same tooling reads a capture from either. A Homey block
 * stands where HA puts its own install details, and the payload sits under
 * `data` exactly as in HA, which is where extract-from-diagnostics.mjs
 * looks for `last_poll` and `control_registers.registers`.
 */

export const DIAGNOSTICS_MARKER = 'AECC_DIAGNOSTICS';

export const APP_DOMAIN = 'nl.stekkerdeal.aecc';

export const REDACTED = '**REDACTED**';

// Word for word the HA integration's _REDACT_KEYS. The first line is what
// this protocol is known to carry, the rest is defensive against a firmware
// that one day returns credentials or location in a response we pass
// through verbatim.
export const REDACT_KEYS: ReadonlySet<string> = new Set([
  'host',
  'serial',
  'device_serial',
  'StorageSN',
  'datalogSn',
  'deviceSn',
  'password',
  'Password',
  'token',
  'Token',
  'secret',
  'api_key',
  'apiKey',
  'email',
  'ssid',
  'SSID',
  'wifi_password',
  'wifiPassword',
  'WifiPassword',
  'mac',
  'MAC',
  'mac_address',
  'macAddress',
  'latitude',
  'longitude',
]);

// 3000-3039 are the documented control registers; 3040-3129 hold a mostly
// empty secondary schedule table on Sunpura, and 3130 is the last address
// observed before the device returns empty strings. Same ranges as HA.
export const REGISTER_RANGE = range(3000, 3130);
export const REGISTER_RANGE_FALLBACK = range(3000, 3039);

// HA's labels, verbatim, so key_registers reads the same in both dumps.
export const KEY_REGISTER_LABELS: ReadonlyArray<readonly [string, string]> = [
  [REG_EMS_ENABLE, 'EMS enable (3000)'],
  [REG_CONTROL_TIME1, 'Control time slot 1 (3003)'],
  [REG_SCHEDULE_MODE, 'Schedule mode (3020)'],
  [REG_AI_SMART_CHARGE, 'AI smart charge (3021)'],
  [REG_AI_SMART_DISC, 'AI smart discharge (3022)'],
  [REG_MIN_SOC, 'Min SOC (3023)'],
  [REG_MAX_SOC, 'Max SOC (3024)'],
  [REG_CUSTOM_MODE, 'Custom mode (3030)'],
  [REG_MAX_FEED_POWER, 'Max feed power (3039)'],
];

// The dump carries the newest few writes only. The session keeps 20, as HA
// does, but five show the last commands and whether they were confirmed,
// and the report Homey sends has a size cap.
export const WRITE_HISTORY_IN_DUMP = 5;

// HA's work-mode names (const.py MODE_CUSTOM / MODE_SELF_CONSUMPTION).
const WORK_MODE_LABELS: Record<WorkMode, string> = {
  custom: 'Custom / Manual',
  self_consumption: 'Self-Consumption (AI)',
};

export interface ControlRegistersSection {
  fetched_at: string;
  registers: Record<string, unknown>;
  key_registers: Record<string, unknown>;
  range: [number, number];
  error: string | null;
}

export type ControlRegisterReader = (
  addresses: number[]
) => Promise<Record<string, unknown> | null>;

export interface DiagnosticsInput {
  homeyVersion: string | null;
  appVersion: string | null;
  brand: BrandId;
  host: string;
  port: number;
  snapshot: SessionSnapshot;
  state: SessionDiagnosticsState;
  writeHistory: WriteHistoryEntry[];
  controlRegisters: ControlRegistersSection;
}

function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

/**
 * Reads the control registers fresh, wide range first and the documented
 * range if that fails, the same fallback HA uses. Never throws: a failed
 * read is written into `error` so the rest of the dump still arrives. An
 * answer in an unexpected shape is recorded as that and not retried, as in
 * HA: the device did answer, so a narrower request would not help.
 */
export async function readControlRegistersSection(
  read: ControlRegisterReader,
  now: () => number
): Promise<ControlRegistersSection> {
  const section: ControlRegistersSection = {
    fetched_at: new Date(now()).toISOString(),
    registers: {},
    key_registers: {},
    range: [3000, 3130],
    error: null,
  };

  let registers: Record<string, unknown> | null = null;
  try {
    registers = await read(REGISTER_RANGE);
    if (registers === null) section.error = 'wide read returned no response';
  } catch (err) {
    if (err instanceof ResponseShapeError) {
      section.error = err.message;
      return section;
    }
    section.error = `wide read failed: ${describeError(err)}`;
  }

  if (registers === null) {
    try {
      registers = await read(REGISTER_RANGE_FALLBACK);
      if (registers === null) {
        section.error = `${section.error}; fallback also returned no response`;
        return section;
      }
    } catch (err) {
      section.error = `${section.error}; fallback also failed: ${describeError(err)}`;
      return section;
    }
    section.range = [3000, 3039];
  }

  section.registers = { ...registers };
  for (const [register, label] of KEY_REGISTER_LABELS) {
    if (register in registers) {
      section.key_registers[label] = registers[register];
    }
  }
  return section;
}

/**
 * Mirrors HA's async_redact_data: any key in the set, at any depth and
 * inside arrays, has its value replaced. Null and empty-string values are
 * left alone, as HA leaves them, so a field that was never set still reads
 * as unset rather than as something hidden.
 */
export function redact(
  value: unknown,
  keys: ReadonlySet<string> = REDACT_KEYS
): unknown {
  if (Array.isArray(value)) return value.map(item => redact(item, keys));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (inner === null || inner === undefined || inner === '') {
      out[key] = inner;
    } else if (keys.has(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = redact(inner, keys);
    }
  }
  return out;
}

// HA writes the direction capitalised: "Charge", "Discharge", "Idle".
function directionLabel(signedW: number): string {
  const direction = directionOf(signedW);
  return direction.charAt(0).toUpperCase() + direction.slice(1);
}

function workModeLabel(mode: WorkMode | null | undefined): string | null {
  return mode ? WORK_MODE_LABELS[mode] : null;
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function unitCount(frame: Record<string, unknown> | null): number {
  const list = frame?.Storage_list;
  return Array.isArray(list) ? list.length : 0;
}

/**
 * Builds the redacted dump. Every section and key HA writes is present;
 * `modbus` is always the unsupported shape, since this app has no Modbus
 * path.
 */
export function buildDiagnostics(input: DiagnosticsInput): unknown {
  const { snapshot, state } = input;
  const profile = getBrandProfile(input.brand);
  const identity = snapshot.identity;
  const initial = state.initial;
  const initialPowerW = initial?.targetPowerW ?? null;

  const cleanerLastAcceptedAt: Record<string, number> = {};
  for (const [key, ms] of Object.entries(state.cleanerLastAcceptedAtMs)) {
    cleanerLastAcceptedAt[key] = ms / 1000;
  }

  const data = {
    integration: {
      domain: APP_DOMAIN,
      version: input.appVersion,
      iot_class: 'local_polling',
    },
    device: {
      manufacturer: BRAND_LABELS[input.brand],
      model: identity?.model ?? null,
      firmware_version: identity?.firmware ?? null,
      device_serial: identity?.serial ?? null,
      host: input.host,
      port: input.port,
      unit_count: unitCount(state.lastRawFrame),
    },
    config: {
      max_charge_power: state.limits.maxChargeW,
      max_discharge_power: state.limits.maxDischargeW,
      max_register_power: Math.max(
        state.limits.maxChargeW,
        state.limits.maxDischargeW
      ),
      brand_profile: {
        soc_zero_reject_during_active_w: profile.socZeroRejectDuringActiveW,
        soc_max_rate_pct_per_min: profile.socMaxRatePctPerMin,
        hold_last_value_seconds: profile.holdLastValueSeconds,
      },
      poll_interval_seconds: state.pollIntervalMs / 1000,
    },
    live_state: {
      // HA's coordinator stays successful through a few failed polls and only
      // turns false past the same tolerance that makes this app report the
      // battery unavailable; consecutive_failures shows anything shorter.
      last_update_success: snapshot.available,
      consecutive_failures: snapshot.consecutiveFailedPolls,
      commanded_power: Math.abs(snapshot.commandedTargetPowerW),
      commanded_direction: directionLabel(snapshot.commandedTargetPowerW),
      commanded_min_soc: snapshot.minSoc,
      commanded_max_soc: snapshot.maxSoc,
      initial_min_soc: initial?.minSoc ?? null,
      initial_max_soc: initial?.maxSoc ?? null,
      initial_work_mode: workModeLabel(initial?.workMode),
      current_work_mode: workModeLabel(snapshot.workMode),
      initial_power: initialPowerW === null ? null : Math.abs(initialPowerW),
      suspect_streak: snapshot.frameGuard.suspectStreak,
      suspect_frames_total: snapshot.frameGuard.suspectFramesTotal,
      last_suspect_reason: snapshot.frameGuard.lastReason,
      last_suspect_at: snapshot.frameGuard.lastAt,
    },
    cleaner_state: {
      last_accepted: { ...state.cleanerLastAccepted },
      last_accepted_at: cleanerLastAcceptedAt,
    },
    modbus: {
      supported: false,
      values: {},
      last_refresh_age_seconds: null,
      last_error: null,
    },
    last_poll: state.lastRawFrame ?? {},
    control_registers: input.controlRegisters,
    write_history: input.writeHistory
      .slice(-WRITE_HISTORY_IN_DUMP)
      .map(entry => ({
        timestamp: isoOrNull(entry.timestampMs),
        operation: entry.operation,
        payload: { ...entry.payload },
        response_received: entry.ok,
        attempts: entry.attempts,
        verify_result:
          entry.verify === null
            ? null
            : entry.verify.map(v => ({
                register: v.register,
                expected: v.expected,
                actual: v.actual ?? null,
                match: v.match,
              })),
      })),
  };

  return redact({
    homey: { version: input.homeyVersion },
    data,
  });
}

// The single log line: marker, space, JSON. One line keeps the dump whole
// in the log and makes finding it in a report a plain text search.
export function formatDiagnosticsLine(dump: unknown): string {
  return `${DIAGNOSTICS_MARKER} ${JSON.stringify(dump)}`;
}
