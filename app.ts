import Homey from 'homey';
import { registerFlowCards } from './lib/homey/flow';

export default class AeccApp extends Homey.App {
  async onInit(): Promise<void> {
    registerFlowCards(this.homey, {
      logger: {
        log: (...args: unknown[]) => this.log(...args),
        error: (...args: unknown[]) => this.error(...args),
      },
    });
    this.log('AECC Battery app initialised');
  }
}

module.exports = AeccApp;
