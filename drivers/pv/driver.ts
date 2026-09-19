import Homey from 'homey';
import {
  buildPvPairDevice,
  findExistingPvForBattery,
  parseBatterySelection,
  toBatteryChoices,
  type BatteryChoice,
  type BatteryDeviceLike,
  type PairedPvDeviceLike,
  type PvPairDevice,
} from './driver-pairing';

export default class AeccPvDriver extends Homey.Driver {
  async onInit(): Promise<void> {
    this.log('AECC PV driver initialised');
  }

  async onPair(session: Homey.Driver.PairSession): Promise<void> {
    // The pair view asks which battery, not which address: everything this
    // device needs to reach the hardware is already configured on the
    // battery device, and a second copy here would drift the moment that
    // one is repaired.
    session.setHandler('list_batteries', async (): Promise<BatteryChoice[]> => {
      const choices = toBatteryChoices(this.batteryDevices());
      this.log(`Pairing: offering ${choices.length} battery device(s)`);
      return choices;
    });

    // Returns the device for the view to create with Homey.createDevice.
    // The add_devices template is deliberately not used: it adds whatever
    // the list_devices view selected, and this driver has no device list
    // to select from, so that path added nothing and closed silently.
    session.setHandler(
      'battery_selected',
      async (data: unknown): Promise<PvPairDevice> => {
        const batteryDeviceId = parseBatterySelection(data);
        const choice = toBatteryChoices(this.batteryDevices()).find(
          candidate => candidate.id === batteryDeviceId
        );
        if (choice === undefined) {
          throw new Error(this.missingBatteryMessage());
        }

        const existing = findExistingPvForBattery(
          this.getDevices() as unknown as PairedPvDeviceLike[],
          batteryDeviceId
        );
        if (existing !== null) {
          throw new Error(this.duplicateMessage(existing));
        }

        this.log(`Pairing: selected battery ${batteryDeviceId}`);
        return buildPvPairDevice(choice);
      }
    );
  }

  private batteryDevices(): BatteryDeviceLike[] {
    return this.homey.drivers
      .getDriver('battery')
      .getDevices() as unknown as BatteryDeviceLike[];
  }

  private missingBatteryMessage(): string {
    return this.homey.__({
      en: 'That battery is no longer available. Go back and pick one from the list.',
      nl: 'Die batterij is niet meer beschikbaar. Ga terug en kies er een uit de lijst.',
    });
  }

  private duplicateMessage(existingDeviceName: string): string {
    return this.homey.__(
      {
        en: 'This battery already has a PV device, "{{name}}". One battery reports one PV total, so a second device would only repeat it.',
        nl: 'Deze batterij heeft al een PV-apparaat, "{{name}}". Een batterij rapporteert één PV-totaal, dus een tweede apparaat zou dat alleen herhalen.',
      },
      { name: existingDeviceName }
    );
  }
}

module.exports = AeccPvDriver;
