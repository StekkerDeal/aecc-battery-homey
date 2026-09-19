import type { SessionRegistry } from '../session-registry';

/**
 * The shape a device needs from the app object: the one SessionRegistry
 * every driver shares.
 *
 * The registry lives on the app rather than on a driver because a battery
 * serves exactly one TCP session and more than one driver now points at the
 * same battery. Two registries would each hold their own entry for the same
 * address and dial it twice.
 *
 * Declared structurally, like FlowHost in ./flow.ts, so lib/ stays free of
 * the Homey SDK and can be unit tested without a Homey.
 */
export interface SessionHost {
  readonly sessions: SessionRegistry;
}

function hasSessions(value: unknown): value is SessionHost {
  if (typeof value !== 'object' || value === null) return false;
  const sessions = (value as { sessions?: unknown }).sessions;
  return typeof sessions === 'object' && sessions !== null;
}

/**
 * Narrows this.homey.app to the registry holder.
 *
 * Takes unknown rather than a cast at the call site for two reasons: the
 * SDK types this.homey.app as the bare Homey.App, which is not comparable
 * to SessionHost, and a device that somehow initialises before the app is
 * ready should fail with a sentence rather than with a TypeError thrown
 * from inside an acquire.
 */
export function sessionHost(app: unknown): SessionHost {
  if (!hasSessions(app)) {
    throw new Error(
      'The AECC app is not available yet, so this device cannot reach the shared session registry.'
    );
  }
  return app;
}
