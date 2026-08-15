import { vi } from 'vitest';

/**
 * Minimal Homey SDK mock for unit tests. Covers the surface used by
 * app.ts, drivers/ and the device layer so lib/ code stays free of the
 * real SDK while app-layer code can still be exercised under vitest.
 */

class App {
  log = vi.fn();
  error = vi.fn();
}

class Driver {
  log = vi.fn();
  error = vi.fn();
}

class DiscoveryResult {
  log = vi.fn();
  error = vi.fn();
}

class Device {
  log = vi.fn();
  error = vi.fn();
  getSetting = vi.fn();
  getSettings = vi.fn();
  setSettings = vi.fn();
  getStoreValue = vi.fn();
  setStoreValue = vi.fn();
  getCapabilityValue = vi.fn();
  setCapabilityValue = vi.fn();
  addCapability = vi.fn();
  removeCapability = vi.fn();
  hasCapability = vi.fn();
  setCapabilityOptions = vi.fn();
  registerCapabilityListener = vi.fn();
  registerMultipleCapabilityListener = vi.fn();
  setAvailable = vi.fn();
  setUnavailable = vi.fn();
}

export default { App, Device, Driver, DiscoveryResult };
