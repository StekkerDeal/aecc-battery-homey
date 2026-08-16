import { describe, expect, it } from 'vitest';
import { planEmsCommand } from './ems-command';

describe('planEmsCommand', () => {
  it('switches to self-consumption when the mode changes to device', () => {
    expect(
      planEmsCommand({
        changed: { target_power_mode: 'device' },
        currentMode: 'homey',
        currentTargetPower: 500,
      })
    ).toEqual({ kind: 'self_consumption' });
  });

  // Verified on a JET: the battery abandons a live setpoint within about 20s
  // of this write, which is what proves register 3003 was cleared.
  it('switches to self-consumption even when the mode was already device', () => {
    expect(
      planEmsCommand({
        changed: { target_power_mode: 'device' },
        currentMode: 'device',
        currentTargetPower: 500,
      })
    ).toEqual({ kind: 'self_consumption' });
  });

  it('applies the stored setpoint when the mode changes to homey', () => {
    expect(
      planEmsCommand({
        changed: { target_power_mode: 'homey' },
        currentMode: 'device',
        currentTargetPower: 500,
      })
    ).toEqual({ kind: 'target_power', watts: 500 });
  });

  it('applies a changed setpoint while already in homey mode', () => {
    expect(
      planEmsCommand({
        changed: { target_power: -300 },
        currentMode: 'homey',
        currentTargetPower: 500,
      })
    ).toEqual({ kind: 'target_power', watts: -300 });
  });

  it('prefers the changed setpoint over the stored one when both arrive', () => {
    expect(
      planEmsCommand({
        changed: { target_power: 800, target_power_mode: 'homey' },
        currentMode: 'device',
        currentTargetPower: 0,
      })
    ).toEqual({ kind: 'target_power', watts: 800 });
  });

  // Moving the slider while the battery runs its own AI must not write: the
  // value is stored for the next switch to Homey control, and the protocol
  // silently drops a share of writes, so a pointless one is not free.
  it('does nothing when only the setpoint moves while the mode is device', () => {
    expect(
      planEmsCommand({
        changed: { target_power: 800 },
        currentMode: 'device',
        currentTargetPower: 0,
      })
    ).toEqual({ kind: 'none' });
  });

  // A freshly paired device has a null setpoint. Number(null) is 0, so the
  // battery correctly did nothing and it read as a failed switch instead.
  it('defaults a null setpoint to zero rather than coercing it silently', () => {
    expect(
      planEmsCommand({
        changed: { target_power_mode: 'homey' },
        currentMode: 'device',
        currentTargetPower: null,
      })
    ).toEqual({ kind: 'target_power', watts: 0 });
  });

  it('defaults an unparseable setpoint to zero instead of NaN', () => {
    expect(
      planEmsCommand({
        changed: { target_power_mode: 'homey' },
        currentMode: 'device',
        currentTargetPower: 'not a number',
      })
    ).toEqual({ kind: 'target_power', watts: 0 });
    expect(
      planEmsCommand({
        changed: { target_power: undefined },
        currentMode: 'homey',
        currentTargetPower: undefined,
      })
    ).toEqual({ kind: 'target_power', watts: 0 });
  });

  it('treats a zero setpoint as a real command, not an absent one', () => {
    expect(
      planEmsCommand({
        changed: { target_power: 0 },
        currentMode: 'homey',
        currentTargetPower: 500,
      })
    ).toEqual({ kind: 'target_power', watts: 0 });
  });

  it('falls back to the current mode when the batch carries no mode', () => {
    expect(
      planEmsCommand({
        changed: {},
        currentMode: 'homey',
        currentTargetPower: 250,
      })
    ).toEqual({ kind: 'target_power', watts: 250 });
  });
});
