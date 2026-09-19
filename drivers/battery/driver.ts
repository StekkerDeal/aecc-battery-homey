import Homey from 'homey';
import { AeccClient } from '../../lib/transport/client';
import {
  applyBrandSettings,
  buildManualPairDevice,
  extractSelectedDevices,
  findHostPortCollision,
  isMdnsSdResult,
  mapDiscoveryResultToPairDevice,
  parseManualConnectPayload,
  parseSetBrandPayload,
  repairFreshnessWindowS,
  runConnectionProbe,
  runRepair,
  type PairListDevice,
} from './driver-pairing';
import {
  settingsFrom,
  type RawSettings,
} from '../../lib/homey/device-settings';
import type AeccDevice from './device';

export default class AeccDriver extends Homey.Driver {
  async onInit(): Promise<void> {
    this.log('AECC battery driver initialised');
  }

  async onPairListDevices(): Promise<PairListDevice[]> {
    const results = this.getDiscoveryStrategy().getDiscoveryResults();
    const devices: PairListDevice[] = [];
    for (const result of Object.values(results)) {
      if (!isMdnsSdResult(result)) continue;
      devices.push(mapDiscoveryResultToPairDevice(result));
    }
    return devices;
  }

  async onPair(session: Homey.Driver.PairSession): Promise<void> {
    const discoveryCache = new Map<string, PairListDevice>();
    let pendingDevices: PairListDevice[] = [];
    let finalDevices: PairListDevice[] | null = null;

    // add_devices has no view of its own; it sources its device array from
    // this same handler, which is why it is re-queried once brand data
    // is ready rather than only serving the initial discovery scan.
    session.setHandler('list_devices', async (): Promise<PairListDevice[]> => {
      if (finalDevices !== null) return finalDevices;
      const devices = await this.onPairListDevices();
      discoveryCache.clear();
      for (const device of devices) discoveryCache.set(device.data.id, device);
      return devices;
    });

    session.setHandler(
      'list_devices_selection',
      async (data: unknown): Promise<void> => {
        pendingDevices = extractSelectedDevices(data, discoveryCache);
      }
    );

    session.setHandler(
      'manual_connect',
      async (data: unknown): Promise<void> => {
        const payload = parseManualConnectPayload(data);

        const collision = findHostPortCollision(
          this.getDevices(),
          payload.host,
          payload.port
        );
        if (collision !== null) {
          throw new Error(this.collisionMessage(collision));
        }

        const client = new AeccClient({
          host: payload.host,
          port: payload.port,
        });
        const outcome = await runConnectionProbe(client);
        if (!outcome.ok) {
          throw new Error(this.probeFailureMessage(outcome.reason));
        }

        pendingDevices = [buildManualPairDevice(payload, outcome.identity)];
      }
    );

    session.setHandler('set_brand', async (data: unknown): Promise<void> => {
      const payload = parseSetBrandPayload(data);
      finalDevices = pendingDevices.map(device =>
        applyBrandSettings(device, payload)
      );
    });
  }

  async onRepair(
    session: Homey.Driver.PairSession,
    device: Homey.Device
  ): Promise<void> {
    // The view prefills itself with the address being corrected, so a user
    // fixing a typo does not have to retype an address that is mostly right.
    session.setHandler('current_address', async () => {
      const settings = settingsFrom(device.getSettings() as RawSettings);
      return { host: settings.host, port: settings.port };
    });

    session.setHandler(
      'manual_connect',
      async (data: unknown): Promise<void> => {
        const payload = parseManualConnectPayload(data);

        const otherDevices = this.getDevices().filter(
          candidate => candidate !== device
        );
        const collision = findHostPortCollision(
          otherDevices,
          payload.host,
          payload.port
        );
        if (collision !== null) {
          throw new Error(this.collisionMessage(collision));
        }

        const aeccDevice = device as AeccDevice;
        const settings = settingsFrom(device.getSettings() as RawSettings);
        const outcome = await runRepair(
          {
            currentHost: settings.host,
            currentPort: settings.port,
            submittedHost: payload.host,
            submittedPort: payload.port,
            readingsAreFresh: aeccDevice.isFresh(
              repairFreshnessWindowS(settings.pollIntervalS)
            ),
          },
          {
            releaseSession: () => aeccDevice.releaseSession(),
            probe: (host, port) =>
              runConnectionProbe(new AeccClient({ host, port })),
            rebind: async (host, port) => {
              await device.setSettings({ host, port });
              // setSettings does not fire onSettings, so the running session
              // would keep polling the old address while the settings page
              // shows the new one. The device has to swap it explicitly.
              await aeccDevice.applyConnectionSettings(host, port);
            },
          }
        );

        // null means the probe was skipped because the device's own session is
        // already answering at this address, which is a successful repair.
        if (outcome !== null && !outcome.ok) {
          throw new Error(this.probeFailureMessage(outcome.reason));
        }
      }
    );
  }

  private probeFailureMessage(
    reason: 'connect_failed' | 'no_valid_data'
  ): string {
    if (reason === 'connect_failed') {
      return this.homey.__({
        en: 'Could not connect to the battery. It accepts only one local connection at a time, so check whether a Home Assistant integration, another Homey or another local client is currently connected, then try again.',
        nl: 'Kon geen verbinding maken met de batterij. Deze accepteert maar één lokale verbinding tegelijk, controleer dus of een Home Assistant-integratie, een andere Homey of een andere lokale client op dit moment verbonden is, en probeer het opnieuw.',
      });
    }
    return this.homey.__({
      en: 'Connected to the battery, but it returned no valid data. It accepts only one local connection at a time, so check whether a Home Assistant integration, another Homey or another local client is currently connected, then try again.',
      nl: 'Er is verbinding gemaakt met de batterij, maar deze gaf geen geldige gegevens terug. De batterij accepteert maar één lokale verbinding tegelijk, controleer dus of een Home Assistant-integratie, een andere Homey of een andere lokale client op dit moment verbonden is, en probeer het opnieuw.',
    });
  }

  private collisionMessage(existingDeviceName: string): string {
    return this.homey.__(
      {
        en: 'This host and port are already used by the paired device "{{name}}". The battery accepts only one connection at a time, so remove or repair that device first.',
        nl: 'Dit host-adres en deze poort zijn al in gebruik door het gekoppelde apparaat "{{name}}". De batterij accepteert maar één verbinding tegelijk, verwijder of herstel dat apparaat eerst.',
      },
      { name: existingDeviceName }
    );
  }
}

module.exports = AeccDriver;
