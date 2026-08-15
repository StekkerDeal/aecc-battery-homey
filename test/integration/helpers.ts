import { AeccSimulator } from '../sim/aecc-simulator';

// Real timers throughout: the simulator is a real TCP server, and mixing
// fake timers with real socket I/O risks deadlocks between the fake timer
// queue and the real event loop. Transport timeouts are kept short via
// FAST_OPTS instead, so tests still run quickly.
export const FAST_OPTS = {
  connectTimeoutMs: 500,
  readTimeoutMs: 400,
  deviceManagementTimeoutMs: 400,
  backoffBaseMs: 30,
  backoffMaxMs: 200,
  closeGraceMs: 50,
};

// Learns a free OS-assigned port by briefly binding then releasing it, so a
// test can point a session at a port before any server is listening there.
export async function freePort(): Promise<number> {
  const probe = await AeccSimulator.start({
    scenario: { last_poll: {}, registers: {} },
    port: 0,
  });
  const port = probe.port;
  await probe.stop();
  return port;
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 20000,
  intervalMs = 40
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
