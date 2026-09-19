import Homey from 'homey';
import {
  AeccSession,
  type AeccSessionUpdatableOptions,
  type Scheduler,
  type SessionEvent,
  type SessionSnapshot,
} from '../../lib/session';
import { sessionHost } from '../../lib/homey/session-host';
import { sessionOptionsFrom } from '../../lib/homey/session-factory';
import { SessionLease } from '../../lib/homey/session-lease';
import {
  EnergyIntegrator,
  shouldPersistMeter,
  type EnergyIntegratorState,
} from '../../lib/protocol/energy-meter';
import type { DerivedTelemetry } from '../../lib/protocol/telemetry';
import {
  mapSnapshot,
  optionalCapabilities,
} from '../../lib/homey/capability-map';
import type { DeviceIdentity } from '../../lib/types';
import {
  triggerControlDriftCorrected,
  triggerControlWriteFailed,
  triggerReadingsBecameStale,
  type AeccFlowDevice,
} from '../../lib/homey/flow';
import {
  settingsFrom,
  type AeccDeviceSettings,
  type RawSettings,
} from '../../lib/homey/device-settings';
import { planEmsCommand } from '../../lib/homey/ems-command';
import { followersOf } from '../../lib/homey/pv-link';

interface OnSettingsEvent {
  oldSettings: RawSettings;
  newSettings: RawSettings;
  changedKeys: string[];
}

// Sub-capabilities added/removed at runtime per optionalCapabilities().
// addCapability/removeCapability are expensive, so the current set is
// tracked to only call them when the desired set actually changes.
const OPTIONAL_CAPABILITY_IDS: readonly string[] = [
  'measure_power.grid',
  'measure_power.pv',
  'measure_power.pv1',
  'measure_power.pv2',
  'measure_power.backup',
  'aecc_signal_strength',
];

export default class AeccDevice extends Homey.Device implements AeccFlowDevice {
  private lease!: SessionLease;
  private meter!: EnergyIntegrator;

  private currentOptionalCapabilities = new Set<string>();

  private lastPersistedChargedKwh = 0;
  private lastPersistedDischargedKwh = 0;
  private lastPersistedAtMs = 0;

  // Cached off the latest snapshot, used by isFresh() and by the drift
  // trigger's tokens without waiting on another session round-trip.
  private lastGoodPollAtMs: number | null = null;
  private lastCommandedTargetPowerW = 0;
  private lastMeasuredPowerW: number | null = null;

  async onInit(): Promise<void> {
    const settings = settingsFrom(this.getSettings() as RawSettings);
    this.lease = new SessionLease({
      registry: sessionHost(this.homey.app).sessions,
      scheduler: this.scheduler(),
      createSession: s => this.createSession(s),
      onEvent: event => {
        void this.handleSessionEvent(event);
      },
    });
    await this.lease.acquire(settings);

    this.restoreMeter();

    await this.setCapabilityOptions('target_power', {
      min: -settings.maxDischargePowerW,
      max: settings.maxChargePowerW,
      step: 10,
      decimals: 0,
    });

    // Never leave the setpoint null: a null reads as 0 anyway once a mode
    // switch coerces it, so make that visible in the UI from the start.
    if (this.getCapabilityValue('target_power') === null) {
      await this.setCapabilityValue('target_power', 0);
    }

    this.currentOptionalCapabilities = new Set(
      this.getCapabilities().filter(id => OPTIONAL_CAPABILITY_IDS.includes(id))
    );

    this.registerMultipleCapabilityListener(
      ['target_power', 'target_power_mode'],
      (values: Record<string, unknown>) => this.handleEmsCapabilities(values),
      500
    );

    this.registerCapabilityListener('aecc_min_soc', async (value: unknown) => {
      const ok = await this.session.setMinSoc(Number(value));
      await this.assertWriteOk(ok, {
        en: 'The battery did not confirm the new discharge limit.',
        nl: 'De batterij heeft de nieuwe ontlaadlimiet niet bevestigd.',
      });
    });

    this.registerCapabilityListener('aecc_max_soc', async (value: unknown) => {
      const ok = await this.session.setMaxSoc(Number(value));
      await this.assertWriteOk(ok, {
        en: 'The battery did not confirm the new charge limit.',
        nl: 'De batterij heeft de nieuwe oplaadlimiet niet bevestigd.',
      });
    });

    this.registerCapabilityListener('button.reset_meters', async () => {
      this.meter.reset();
      await this.persistMeter();
      await this.setCapabilityValue('meter_power.charged', 0);
      await this.setCapabilityValue('meter_power.discharged', 0);
    });
  }

  // The session this device currently holds. Throws rather than handing a
  // null to the transport if something calls a control path while the
  // device is between leases.
  private get session(): AeccSession {
    return this.lease.requireSession();
  }

  private scheduler(): Scheduler {
    return {
      setTimeout: (handler, ms) => this.homey.setTimeout(handler, ms),
      clearTimeout: handle => this.homey.clearTimeout(handle as NodeJS.Timeout),
      now: () => Date.now(),
    };
  }

  // Hands this device's single TCP session slot back so something else can
  // own it, today the repair probe. Only the polling session goes away; the
  // meter, capabilities and settings are untouched. Whatever releases it must
  // pair this with applyConnectionSettings(), which acquires a fresh one:
  // between the two the device has no session, and a control command arriving
  // in that window fails honestly rather than reaching the battery.
  async releaseSession(): Promise<void> {
    // Followers first: a solar device holding a second reference would keep
    // the session polling after this release, and the repair probe would
    // then fight a live socket and report a failure that is not real.
    await this.detachPvFollowers();
    await this.lease.release();
  }

  private async rebindSession(settings: AeccDeviceSettings): Promise<void> {
    await this.releaseSession();
    await this.lease.acquire(settings);
    // After this device owns the new key, so followers join a session that
    // is already acquired and the decision to start it stays here. They are
    // handed the settings just bound rather than being left to read them
    // back: on the settings-page path Homey has not persisted them yet.
    await this.attachPvFollowers(settings);
  }

  /**
   * The solar devices that follow this battery.
   *
   * Absent PV driver, absent devices and devices that predate the follower
   * contract all resolve to an empty list rather than an error: repair and
   * a settings edit must keep working exactly as they did for the users
   * who have no PV device at all, which today is all of them.
   */
  private pvFollowers(): ReturnType<typeof followersOf> {
    try {
      const devices = this.homey.drivers.getDriver('pv').getDevices();
      return followersOf(devices, this.getData().id);
    } catch (error) {
      this.error('Could not look up PV devices', error);
      return [];
    }
  }

  private async detachPvFollowers(): Promise<void> {
    const followers = this.pvFollowers();
    if (followers.length > 0) {
      this.log(
        `Releasing the session, detaching ${followers.length} PV device(s)`
      );
    }
    for (const follower of followers) {
      try {
        await follower.detachFromBattery();
      } catch (error) {
        this.error('A PV device failed to detach', error);
      }
    }
  }

  private async attachPvFollowers(
    settings?: AeccDeviceSettings
  ): Promise<void> {
    const followers = this.pvFollowers();
    if (followers.length > 0 && settings !== undefined) {
      this.log(
        `Reattaching ${followers.length} PV device(s) to ${settings.host}:${settings.port}`
      );
    }
    for (const follower of followers) {
      try {
        await follower.attachToBattery(settings);
      } catch (error) {
        this.error('A PV device failed to reattach', error);
      }
    }
  }

  // onRepair writes the new address with setSettings, which the SDK
  // explicitly does not route through onSettings, so the repair path has to
  // swap the session itself or it keeps polling the old address.
  async applyConnectionSettings(host: string, port: number): Promise<void> {
    const settings = settingsFrom(this.getSettings() as RawSettings);
    await this.rebindSession({ ...settings, host, port });
  }

  async onSettings({
    newSettings,
    changedKeys,
  }: OnSettingsEvent): Promise<string | void> {
    const settings = settingsFrom(newSettings);

    if (changedKeys.includes('host') || changedKeys.includes('port')) {
      await this.rebindSession(settings);
    } else {
      const patch: AeccSessionUpdatableOptions = {};
      if (changedKeys.includes('poll_interval')) {
        patch.pollIntervalMs = settings.pollIntervalS * 1000;
      }
      if (changedKeys.includes('verify_interval')) {
        patch.verifyIntervalMs = settings.verifyIntervalS * 1000;
      }
      if (changedKeys.includes('brand')) {
        patch.brand = settings.brand;
      }
      if (
        changedKeys.includes('max_charge_power') ||
        changedKeys.includes('max_discharge_power')
      ) {
        patch.limits = {
          maxChargeW: settings.maxChargePowerW,
          maxDischargeW: settings.maxDischargePowerW,
        };
      }
      if (Object.keys(patch).length > 0) {
        this.session.updateOptions(patch);
      }
    }

    if (
      changedKeys.includes('max_charge_power') ||
      changedKeys.includes('max_discharge_power')
    ) {
      await this.setCapabilityOptions('target_power', {
        min: -settings.maxDischargePowerW,
        max: settings.maxChargePowerW,
        step: 10,
        decimals: 0,
      });
    }
  }

  async onUninit(): Promise<void> {
    await this.teardown();
  }

  async onDeleted(): Promise<void> {
    // Followers first, and deliberately without a reattach: nothing will
    // point at this battery again. Without this they keep a reference on a
    // session for a device that no longer exists, which keeps it polling
    // until the next app restart, and in the window before a staggered
    // start has fired it leaves them attached to a session nobody ever
    // starts: connected-looking, never updating, and silent.
    await this.detachPvFollowers();
    await this.teardown();
  }

  // --- AeccFlowDevice -----------------------------------------------------

  async setChargePower(watts: number): Promise<void> {
    const ok = await this.session.setTargetPower(Math.abs(watts));
    await this.assertWriteOk(ok, {
      en: 'The battery did not confirm the charge command.',
      nl: 'De batterij heeft het laadcommando niet bevestigd.',
    });
  }

  async setDischargePower(watts: number): Promise<void> {
    const ok = await this.session.setTargetPower(-Math.abs(watts));
    await this.assertWriteOk(ok, {
      en: 'The battery did not confirm the discharge command.',
      nl: 'De batterij heeft het ontlaadcommando niet bevestigd.',
    });
  }

  async stopBattery(): Promise<void> {
    const ok = await this.session.setTargetPower(0);
    await this.assertWriteOk(ok, {
      en: 'The battery did not confirm the stop command.',
      nl: 'De batterij heeft het stopcommando niet bevestigd.',
    });
  }

  async setSocLimits(minSoc: number, maxSoc: number): Promise<void> {
    const [minOk, maxOk] = await Promise.all([
      this.session.setMinSoc(minSoc),
      this.session.setMaxSoc(maxSoc),
    ]);
    await this.assertWriteOk(minOk && maxOk, {
      en: 'The battery did not confirm the new charge/discharge limits.',
      nl: 'De batterij heeft de nieuwe oplaad-/ontlaadlimieten niet bevestigd.',
    });
  }

  async reapplySetpoint(): Promise<void> {
    const ok = await this.session.reapplySetpoint();
    await this.assertWriteOk(ok, {
      en: 'The battery did not confirm the setpoint.',
      nl: 'De batterij heeft het setpoint niet bevestigd.',
    });
  }

  isFresh(seconds: number): boolean {
    if (this.lastGoodPollAtMs === null) return false;
    return Date.now() - this.lastGoodPollAtMs <= seconds * 1000;
  }

  // --- setup helpers --------------------------------------------------------

  private createSession(settings: AeccDeviceSettings): AeccSession {
    const scheduler: Scheduler = {
      setTimeout: (handler, ms) => this.homey.setTimeout(handler, ms),
      clearTimeout: handle => this.homey.clearTimeout(handle),
      now: () => Date.now(),
    };
    return new AeccSession(sessionOptionsFrom(settings, scheduler));
  }

  private restoreMeter(): void {
    const stored = this.getStoreValue(
      'energyMeter'
    ) as EnergyIntegratorState | null;
    // Never restore lastSampleAtMs: EnergyIntegratorState never carries it,
    // so a restart cannot integrate energy across its own downtime.
    const state: EnergyIntegratorState = stored ?? {
      chargedKwh:
        (this.getCapabilityValue('meter_power.charged') as number | null) ?? 0,
      dischargedKwh:
        (this.getCapabilityValue('meter_power.discharged') as number | null) ??
        0,
    };
    this.meter = new EnergyIntegrator(state);
    this.lastPersistedChargedKwh = state.chargedKwh;
    this.lastPersistedDischargedKwh = state.dischargedKwh;
    this.lastPersistedAtMs = Date.now();
  }

  private async teardown(): Promise<void> {
    await this.persistMeter();
    // The lease blanks its own key, so onDeleted followed by onUninit
    // releases once rather than dropping the refcount of a session another
    // device is still using.
    await this.lease.release();
  }

  // --- EMS capability listener ---------------------------------------------

  private async handleEmsCapabilities(
    capabilityValues: Record<string, unknown>
  ): Promise<void> {
    const command = planEmsCommand({
      changed: capabilityValues,
      currentMode: this.getCapabilityValue('target_power_mode'),
      currentTargetPower: this.getCapabilityValue('target_power'),
    });

    if (command.kind === 'none') return;

    if (command.kind === 'self_consumption') {
      // Clears register 3003: without this the firmware keeps running the
      // previous manual setpoint instead of handing control back to the AI.
      const ok = await this.session.setWorkMode('self_consumption');
      await this.assertWriteOk(ok, {
        en: 'Could not switch to self-consumption mode.',
        nl: 'Overschakelen naar zelfconsumptiemodus is mislukt.',
      });
      return;
    }

    // setTargetPower's payload already includes the full custom-mode register
    // set plus the setpoint in one write, so this call both takes control and
    // applies it. Without it the device stays idle until the next command.
    // The resolved value is written back so the tile shows 0W rather than
    // leaving the user wondering why nothing happened.
    if (this.getCapabilityValue('target_power') !== command.watts) {
      await this.setCapabilityValue('target_power', command.watts);
    }

    const ok = await this.session.setTargetPower(command.watts);
    await this.assertWriteOk(ok, {
      en: 'Could not apply the target power to the battery.',
      nl: 'Het doelvermogen kon niet naar de batterij worden geschreven.',
    });
  }

  private async assertWriteOk(
    ok: boolean,
    message: { en: string; nl: string }
  ): Promise<void> {
    if (ok) return;
    throw new Error(this.homey.__(message));
  }

  // --- session events -------------------------------------------------------

  private async handleSessionEvent(event: SessionEvent): Promise<void> {
    switch (event.type) {
      case 'snapshot':
        await this.handleSnapshotEvent(event.snapshot);
        return;
      case 'available':
        await this.setAvailable();
        return;
      case 'unavailable':
        await this.handleUnavailableEvent();
        return;
      case 'write':
        await this.handleWriteEvent(event);
        return;
      case 'drift':
        await this.handleDriftEvent(event);
        return;
    }
  }

  private async handleSnapshotEvent(snapshot: SessionSnapshot): Promise<void> {
    // Optional capabilities must exist before anything writes to them. A
    // write to a missing capability throws and aborts the rest of this
    // handler, so the capability would never be added and every later poll
    // would fail the same way.
    if (snapshot.telemetry) {
      await this.syncOptionalCapabilities(
        snapshot.telemetry,
        snapshot.identity ?? {}
      );
    }

    this.lastGoodPollAtMs = snapshot.lastGoodPollAtMs;
    this.lastCommandedTargetPowerW = snapshot.commandedTargetPowerW;
    if (snapshot.telemetry) {
      this.lastMeasuredPowerW = snapshot.telemetry.measurePowerW;
    }

    // Absent readings are null, never 0: skip the sample rather than
    // integrating a fabricated zero-power period.
    if (snapshot.telemetry && snapshot.telemetry.measurePowerW !== null) {
      const nowMs = snapshot.lastGoodPollAtMs ?? Date.now();
      this.meter.sample(nowMs, snapshot.telemetry.measurePowerW);
    }

    for (const update of mapSnapshot(snapshot, this.meter)) {
      // Skip unknown ids rather than throwing: one unexpected capability
      // must not take down the whole snapshot path.
      if (!this.hasCapability(update.id)) continue;
      await this.setCapabilityValue(update.id, update.value);
    }

    if (snapshot.identity) {
      await this.syncIdentitySettings(snapshot.identity);
    }

    await this.maybePersistMeter(snapshot.lastPollAtMs ?? Date.now());
  }

  // The settings page carries read-only serial, firmware and model labels
  // that pairing cannot fill: discovery never probes identity and the serial
  // only reaches the store. Programmatic setSettings does not re-enter
  // onSettings, so writing them back here cannot loop.
  private async syncIdentitySettings(identity: DeviceIdentity): Promise<void> {
    const current = this.getSettings() as RawSettings;
    const patch: RawSettings = {};
    if (identity.serial !== undefined && current.serial !== identity.serial) {
      patch.serial = identity.serial;
    }
    if (
      identity.firmware !== undefined &&
      current.firmware !== identity.firmware
    ) {
      patch.firmware = identity.firmware;
    }
    if (identity.model !== undefined && current.model !== identity.model) {
      patch.model = identity.model;
    }
    if (Object.keys(patch).length === 0) return;
    await this.setSettings(patch);
  }

  private async handleUnavailableEvent(): Promise<void> {
    await this.persistMeter();

    const settings = settingsFrom(this.getSettings() as RawSettings);
    const seconds =
      this.lastGoodPollAtMs === null
        ? 0
        : Math.max(0, Math.round((Date.now() - this.lastGoodPollAtMs) / 1000));
    await triggerReadingsBecameStale(this.homey, this, { seconds });

    await this.setUnavailable(
      this.homey.__({
        en: `Cannot reach the battery at ${settings.host}:${settings.port}. The AECC protocol allows only one active connection per device: check that no other app or session (including the manufacturer app) is also connected to it.`,
        nl: `Kan de batterij op ${settings.host}:${settings.port} niet bereiken. Het AECC-protocol staat maar één actieve verbinding per apparaat toe: controleer of er geen andere app of sessie (waaronder de app van de fabrikant) al mee verbonden is.`,
      })
    );
  }

  private async handleWriteEvent(
    event: Extract<SessionEvent, { type: 'write' }>
  ): Promise<void> {
    if (!event.ok) {
      // Logged as well as triggered: a flow card only helps users who already
      // built a flow, and a bug report needs the failure in the app log.
      this.error(
        `control write failed: ${event.operation} after ${event.attempts} attempts`
      );
      await triggerControlWriteFailed(this.homey, this, {
        operation: event.operation,
        attempts: event.attempts,
      });
    }
  }

  private async handleDriftEvent(
    event: Extract<SessionEvent, { type: 'drift' }>
  ): Promise<void> {
    this.log(
      `drift corrected: expected ${event.expectedPowerW}W, found ${event.foundPowerW}W`
    );
    await triggerControlDriftCorrected(this.homey, this, {
      expected: event.expectedPowerW,
      found: event.foundPowerW,
    });
  }

  private async syncOptionalCapabilities(
    derived: DerivedTelemetry,
    identity: DeviceIdentity
  ): Promise<void> {
    const desired = new Set(optionalCapabilities(derived, identity));
    const toAdd = [...desired].filter(
      id => !this.currentOptionalCapabilities.has(id)
    );
    const toRemove = [...this.currentOptionalCapabilities].filter(
      id => !desired.has(id)
    );
    if (toAdd.length === 0 && toRemove.length === 0) return;

    for (const id of toAdd) await this.addCapability(id);
    for (const id of toRemove) await this.removeCapability(id);
    this.currentOptionalCapabilities = desired;
  }

  // --- energy meter persistence ----------------------------------------------

  private async maybePersistMeter(nowMs: number): Promise<void> {
    const due = shouldPersistMeter({
      currentChargedKwh: this.meter.chargedKwh,
      currentDischargedKwh: this.meter.dischargedKwh,
      lastPersistedChargedKwh: this.lastPersistedChargedKwh,
      lastPersistedDischargedKwh: this.lastPersistedDischargedKwh,
      nowMs,
      lastPersistedAtMs: this.lastPersistedAtMs,
    });
    if (due) {
      await this.persistMeter();
    }
  }

  private async persistMeter(): Promise<void> {
    const state = this.meter.serialize();
    await this.setStoreValue('energyMeter', state);
    this.lastPersistedChargedKwh = state.chargedKwh;
    this.lastPersistedDischargedKwh = state.dischargedKwh;
    this.lastPersistedAtMs = Date.now();
  }
}

module.exports = AeccDevice;
