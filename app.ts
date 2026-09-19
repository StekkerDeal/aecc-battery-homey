import Homey from 'homey';
import { registerFlowCards } from './lib/homey/flow';
import { SessionRegistry } from './lib/session-registry';

export default class AeccApp extends Homey.App {
  // A field initialiser, not an onInit assignment: a device's onInit may
  // reach for this before the app's own onInit has run, and the registry is
  // the one thing it cannot do without.
  public readonly sessions = new SessionRegistry();

  async onInit(): Promise<void> {
    registerFlowCards(this.homey, {
      logger: {
        log: (...args: unknown[]) => this.log(...args),
        error: (...args: unknown[]) => this.error(...args),
      },
    });
    this.log('AECC Battery app initialised');
  }

  // Devices release their own reference on teardown, but the order the SDK
  // tears app and devices down in is not guaranteed. Stopping whatever is
  // left keeps an app update from leaving a socket behind that still holds
  // the battery's only session slot. Releases arriving afterwards hit an
  // absent key and no-op.
  async onUninit(): Promise<void> {
    await this.sessions.stopAll();
  }
}

module.exports = AeccApp;
