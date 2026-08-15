import { afterEach, describe, expect, it } from 'vitest';
import { AeccSimulator, type Scenario } from '../sim/aecc-simulator';
import { AeccSession, systemScheduler } from '../../lib/session';
import lunergyNoStorage from '../fixtures/lunergy-no-storage.json';
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

describe('AeccSession against the Lunergy shape (no Storage_list)', () => {
  it('produces usable telemetry from SSumInfoList alone', async () => {
    sim = await AeccSimulator.start({
      scenario: lunergyNoStorage as unknown as Scenario,
      port: 0,
      omitStorageList: true,
    });
    session = new AeccSession({
      host: '127.0.0.1',
      port: sim.port,
      brand: 'lunergy',
      limits: { maxChargeW: 800, maxDischargeW: 800 },
      scheduler: systemScheduler,
      pollIntervalMs: 2000,
      verifyIntervalMs: 0,
      ...FAST_OPTS,
    });

    await session.start();

    const snap = session.snapshot;
    expect(snap.hasStorageList).toBe(false);
    expect(snap.telemetry?.socPct).toBe(62);
    expect(snap.telemetry?.hasStorageList).toBe(false);
    expect(snap.telemetry?.measurePowerW).toBe(-340);
    expect(snap.telemetry?.chargingState).toBe('discharging');
    expect(snap.available).toBe(true);
  }, 10000);

  it('can still write and verify control registers with no Storage_list', async () => {
    sim = await AeccSimulator.start({
      scenario: lunergyNoStorage as unknown as Scenario,
      port: 0,
      omitStorageList: true,
    });
    session = new AeccSession({
      host: '127.0.0.1',
      port: sim.port,
      brand: 'lunergy',
      limits: { maxChargeW: 800, maxDischargeW: 800 },
      scheduler: systemScheduler,
      pollIntervalMs: 2000,
      verifyIntervalMs: 0,
      ...FAST_OPTS,
    });

    const ok = await session.setTargetPower(300);
    expect(ok).toBe(true);
    // hasStorageList is false, so field7 must be 4, not 5.
    expect(sim.registers.get('3003')).toBe(
      '1,00:00,23:59,-300,0,6,4,0,0,100,10'
    );
  }, 10000);
});
