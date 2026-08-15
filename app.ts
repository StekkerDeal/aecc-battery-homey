import Homey from 'homey';

export default class AeccApp extends Homey.App {
  async onInit(): Promise<void> {
    this.log('AECC Battery app initialised');
  }
}

module.exports = AeccApp;
