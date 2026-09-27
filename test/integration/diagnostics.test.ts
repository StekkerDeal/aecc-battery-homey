import { afterEach, describe, expect, it } from 'vitest';
import { AeccSimulator, type Scenario } from '../sim/aecc-simulator';
import { AeccSession, systemScheduler } from '../../lib/session';
import {
  buildDiagnostics,
  readControlRegistersSection,
  REDACTED,
} from '../../lib/diagnostics';
import jetSingleUnit from '../fixtures/jet-single-unit.json';
import { FAST_OPTS } from './helpers';

let sim: AeccSimulator | undefined;
let session: AeccSession | undefined;

afterEach(async () => {
  if (session) {
    await session.stop();
    session = undefined;
  }
  if (sim) {
    await sim.stop();
    sim = undefined;
  }
});

const scenario = jetSingleUnit as unknown as Scenario;

// The button's path end to end, minus the Homey device class: a running
// session, the fresh register read through that same session, and the
// dump built from it. The simulator refuses a second connection, so a dump
// that opened its own socket would fail here instead of silently on a
// real battery, which accepts a second session and then ignores it.
describe('diagnostics dump against the simulator', () => {
  it('carries the fixture frame and all 131 registers over the one connection', async () => {
    sim = await AeccSimulator.start({
      scenario,
      port: 0,
      refuseSecondConnection: true,
    });
    session = new AeccSession({
      host: '127.0.0.1',
      port: sim.port,
      brand: 'jet',
      limits: { maxChargeW: 800, maxDischargeW: 800 },
      scheduler: systemScheduler,
      pollIntervalMs: 2000,
      verifyIntervalMs: 0,
      ...FAST_OPTS,
    });
    await session.start();
    const active = session;

    const controlRegisters = await readControlRegistersSection(
      addresses => active.readControlRegisters(addresses),
      () => Date.now()
    );
    const dump = buildDiagnostics({
      homeyVersion: '13.5.0',
      appVersion: '1.2.1',
      brand: 'jet',
      host: '127.0.0.1',
      port: sim.port,
      snapshot: active.snapshot,
      state: active.diagnosticsState,
      writeHistory: active.writeHistory,
      controlRegisters,
    }) as {
      data: {
        device: Record<string, unknown>;
        last_poll: Record<string, unknown>;
        control_registers: {
          registers: Record<string, unknown>;
          range: number[];
          error: string | null;
        };
      };
    };

    expect(sim.connections).toBe(1);

    const registers = dump.data.control_registers;
    expect(registers.error).toBeNull();
    expect(registers.range).toEqual([3000, 3130]);
    expect(Object.keys(registers.registers)).toHaveLength(131);
    for (const [address, value] of Object.entries(registers.registers)) {
      expect(scenario.registers[address]).toBe(value);
    }

    const expected = scenario.last_poll;
    expect(dump.data.last_poll.SSumInfoList).toEqual(expected.SSumInfoList);
    const units = dump.data.last_poll.Storage_list as Record<string, unknown>[];
    expect(units).toHaveLength(expected.Storage_list?.length ?? 0);
    for (const unit of units) expect(unit.StorageSN).toBe(REDACTED);

    expect(dump.data.device.host).toBe(REDACTED);
    expect(dump.data.device.device_serial).toBe(REDACTED);
    expect(dump.data.device.unit_count).toBe(expected.Storage_list?.length);
  });
});
