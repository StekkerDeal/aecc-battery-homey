import Homey from 'homey';
import {
  AeccSession,
  type Scheduler,
  type SessionEvent,
  type SessionSnapshot,
} from '../../lib/session';
import { sessionHost } from '../../lib/homey/session-host';
import { sessionOptionsFrom } from '../../lib/homey/session-factory';
import { SessionLease } from '../../lib/homey/session-lease';
import {
  ProductionIntegrator,
  shouldPersistProductionMeter,
  type ProductionIntegratorState,
} from '../../lib/protocol/energy-meter';
import { mapPvSnapshot } from '../../lib/homey/capability-map';
import {
  settingsFrom,
  type AeccDeviceSettings,
  type RawSettings,
} from '../../lib/homey/device-settings';
import type { PvFollower } from '../../lib/homey/pv-link';

const METER_STORE_KEY = 'pvEnergyMeter';

interface BatterySettingsSource {
  getSettings(): unknown;
}

/**
 * The battery's PV input as its own solarpanel device.
 *
 * It owns no connection of its own: it takes a second reference on the
 * session its battery already runs, because the hardware serves one TCP
 * session at a time. It never writes, so every control path stays with the
 * battery device, and it reports one reading and one counter.
 */
export default class AeccPvDevice extends Homey.Device implements PvFollower {
  private lease!: SessionLease;
  private meter!: ProductionIntegrator;

  private lastPersistedGeneratedKwh = 0;
  private lastPersistedAtMs = 0;
  // Serialises attach and detach against each other, see attachToBattery.
  private inFlight: Promise<void> = Promise.resolve();

  get batteryDeviceId(): string {
    const stored = this.getStoreValue('batteryDeviceId');
    return typeof stored === 'string' ? stored : '';
  }

  async onInit(): Promise<void> {
    this.lease = new SessionLease({
      registry: sessionHost(this.homey.app).sessions,
      scheduler: this.scheduler(),
      createSession: settings => this.createSession(settings),
      onEvent: event => {
        void this.handleSessionEvent(event);
      },
    });

    // Before the battery lookup, so a device whose link is broken still
    // restores its counter and still answers the reset button.
    this.restoreMeter();
    this.registerCapabilityListener('button.reset_meters', async () => {
      this.meter.reset();
      await this.persistMeter();
      await this.setCapabilityValue('meter_power', 0);
    });

    await this.attachToBattery();
  }

  async onUninit(): Promise<void> {
    await this.teardown();
  }

  async onDeleted(): Promise<void> {
    await this.teardown();
  }

  /**
   * Lets go of the shared session.
   *
   * Called by the battery device before it releases its own reference, so
   * the repair probe finds the TCP slot genuinely free. Without this the
   * refcount never reaches zero, the session keeps polling, and the probe
   * fights a live socket and reports a failure that is not real.
   */
  async detachFromBattery(): Promise<void> {
    this.inFlight = this.inFlight.then(() => this.detachNow());
    await this.inFlight;
  }

  private async detachNow(): Promise<void> {
    if (!this.lease.held) return;
    this.log(`Detaching from ${this.lease.key}`);
    await this.persistMeter();
    await this.lease.release();
    // Availability follows the session: with no session this device has no
    // reading, and saying so is what makes a deleted battery visible here
    // instead of leaving the last value on screen looking live.
    await this.setUnavailable(
      this.homey.__({
        en: 'Not connected to the battery this device belongs to.',
        nl: 'Geen verbinding met de batterij waar dit apparaat bij hoort.',
      })
    );
  }

  /**
   * Joins the session for whatever address the battery device now has.
   *
   * Called by the battery device after it has re-acquired, which is what
   * moves this device to a new address after a repair instead of leaving
   * it holding a session nobody points at any more.
   */
  async attachToBattery(boundSettings?: AeccDeviceSettings): Promise<void> {
    // Chained rather than concurrent: this device's own startup and a
    // repair on the battery can overlap, and two attaches that both got
    // past the detach would each take a reference while only one is ever
    // released, leaving a refcount the next repair can never bring to zero.
    this.inFlight = this.inFlight.then(() => this.attachNow(boundSettings));
    await this.inFlight;
  }

  private async attachNow(boundSettings?: AeccDeviceSettings): Promise<void> {
    await this.detachNow();

    const battery = await this.findBatteryDevice();
    if (battery === null) {
      await this.setUnavailable(
        this.homey.__({
          en: 'The battery this device belongs to is gone. Remove this device and add it again after pairing the battery.',
          nl: 'De batterij waar dit apparaat bij hoort, bestaat niet meer. Verwijder dit apparaat en voeg het opnieuw toe nadat de batterij is gekoppeld.',
        })
      );
      return;
    }

    // The battery hands over what it just bound to during a rebind; only
    // on this device's own startup is reading the battery's stored
    // settings the right thing to do. See PvFollower.
    const settings =
      boundSettings ?? settingsFrom(battery.getSettings() as RawSettings);

    // The lease subscribes and schedules the start before returning, so a
    // capability write throwing below can no longer leave a session this
    // device created unstarted. Only the creator ever starts one.
    const { session, created } = await this.lease.acquire(settings);
    this.log(
      created
        ? `Attached to ${this.lease.key}, which this device started`
        : `Attached to ${this.lease.key}, sharing the battery's session`
    );

    // subscribe() has no replay, so a device joining a session that is
    // already polling would otherwise show nothing until the next tick.
    // The getter is always current.
    await this.handleSnapshot(session.snapshot);

    // The session only emits `available` after it has emitted
    // `unavailable`, so a device joining a healthy session is never told
    // it is fine. Read the current state instead of waiting for an edge
    // that may never come.
    if (session.snapshot.available) {
      await this.setAvailable();
    } else {
      await this.setUnavailable(this.noDataMessage());
    }
  }

  private scheduler(): Scheduler {
    return {
      setTimeout: (handler, ms) => this.homey.setTimeout(handler, ms),
      clearTimeout: handle => this.homey.clearTimeout(handle as NodeJS.Timeout),
      now: () => Date.now(),
    };
  }

  // Only reached when this device wins the race to the battery, which is
  // the uncommon case: normally the battery device has already created the
  // session and this one joins it.
  private createSession(settings: AeccDeviceSettings): AeccSession {
    return new AeccSession(sessionOptionsFrom(settings, this.scheduler()));
  }

  private noDataMessage(): string {
    return this.homey.__({
      en: 'No data from the battery this device belongs to.',
      nl: 'Geen gegevens van de batterij waar dit apparaat bij hoort.',
    });
  }

  private async findBatteryDevice(): Promise<BatterySettingsSource | null> {
    const id = this.batteryDeviceId;
    if (id === '') return null;
    try {
      const driver = this.homey.drivers.getDriver('battery');
      await driver.ready();
      const device = driver.getDevice({ id });
      return device as unknown as BatterySettingsSource;
    } catch {
      // getDevice throws for an id Homey does not know, which is the normal
      // outcome when the battery was deleted or re-paired at a new address.
      return null;
    }
  }

  private async handleSessionEvent(event: SessionEvent): Promise<void> {
    switch (event.type) {
      case 'snapshot':
        await this.handleSnapshot(event.snapshot);
        break;
      case 'available':
        await this.setAvailable();
        break;
      case 'unavailable':
        await this.persistMeter();
        await this.setUnavailable(this.noDataMessage());
        break;
      // write and drift are the battery's business. This device commands
      // nothing, and their flow cards are filtered to the battery driver.
      default:
        break;
    }
  }

  private async handleSnapshot(snapshot: SessionSnapshot): Promise<void> {
    const watts = snapshot.telemetry?.pvTotalPowerW ?? null;
    if (watts !== null) {
      this.meter.sample(snapshot.lastGoodPollAtMs ?? Date.now(), watts);
    }

    for (const update of mapPvSnapshot(
      snapshot,
      this.meter,
      this.homey.clock.getTimezone()
    )) {
      if (!this.hasCapability(update.id)) continue;
      await this.setCapabilityValue(update.id, update.value);
    }

    await this.maybePersistMeter(snapshot.lastPollAtMs ?? Date.now());
  }

  private restoreMeter(): void {
    const stored = this.getStoreValue(METER_STORE_KEY) as
      ProductionIntegratorState | null | undefined;
    // An empty store falls back to the capability, so a lost store value
    // continues the counter instead of restarting it at zero.
    const fallback = this.getCapabilityValue('meter_power');
    const state: ProductionIntegratorState = {
      generatedKwh:
        stored?.generatedKwh ?? (typeof fallback === 'number' ? fallback : 0),
    };
    this.meter = new ProductionIntegrator(state);
    this.lastPersistedGeneratedKwh = state.generatedKwh;
    this.lastPersistedAtMs = Date.now();
  }

  private async maybePersistMeter(nowMs: number): Promise<void> {
    const due = shouldPersistProductionMeter({
      currentGeneratedKwh: this.meter.generatedKwh,
      lastPersistedGeneratedKwh: this.lastPersistedGeneratedKwh,
      nowMs,
      lastPersistedAtMs: this.lastPersistedAtMs,
    });
    if (!due) return;
    await this.persistMeter();
  }

  private async persistMeter(): Promise<void> {
    await this.setStoreValue(METER_STORE_KEY, this.meter.serialize());
    this.lastPersistedGeneratedKwh = this.meter.generatedKwh;
    this.lastPersistedAtMs = Date.now();
  }

  private async teardown(): Promise<void> {
    await this.persistMeter();
    // Through the chain, so a teardown landing while the battery is mid
    // repair cannot release a reference the reattach is still taking.
    this.inFlight = this.inFlight.then(() => this.lease.release());
    await this.inFlight;
  }
}

module.exports = AeccPvDevice;
