// The decision half of the EMS capability listener, kept pure so it can be
// tested: device.ts cannot be imported under vitest because it mixes
// `export default` with a `module.exports =` reassignment for Homey's CJS
// loader, the same reason driver-pairing.ts was split out of driver.ts.
export type EmsCommand =
  | { kind: 'self_consumption' }
  | { kind: 'target_power'; watts: number }
  | { kind: 'none' };

export interface EmsCommandInput {
  /** Only the capabilities Homey reported as changed in this batch. */
  changed: Record<string, unknown>;
  currentMode: unknown;
  currentTargetPower: unknown;
}

export function planEmsCommand(input: EmsCommandInput): EmsCommand {
  const mode = String(input.changed.target_power_mode ?? input.currentMode);

  if (mode === 'device') {
    // Only the setpoint moved while the battery runs its own AI. Homey has
    // already stored the value for the next switch to Homey control, so
    // re-sending the self-consumption register set would be a write with no
    // effect on a protocol that silently drops a share of them.
    if (input.changed.target_power_mode === undefined) return { kind: 'none' };
    return { kind: 'self_consumption' };
  }

  // A freshly paired device has no setpoint yet and Number(null) is 0, so the
  // default is explicit here rather than arriving through a silent coercion.
  const raw = input.changed.target_power ?? input.currentTargetPower;
  const parsed = Number(raw);
  return { kind: 'target_power', watts: Number.isFinite(parsed) ? parsed : 0 };
}
