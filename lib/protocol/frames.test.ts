import { describe, expect, it } from 'vitest';
import {
  buildGet,
  buildSet,
  encodeRequest,
  JsonAccumulator,
  readRegister,
  unwrapContainer,
} from './frames';

describe('buildGet', () => {
  it('builds a Get envelope with CommandSource Homey', () => {
    expect(buildGet('EnergyParameter', 1)).toEqual({
      Get: 'EnergyParameter',
      SerialNumber: 1,
      CommandSource: 'Homey',
    });
  });

  it('merges extra fields', () => {
    expect(
      buildGet('Energycontrolparameters', 2, { RegControlAddr: [3000] })
    ).toEqual({
      Get: 'Energycontrolparameters',
      SerialNumber: 2,
      CommandSource: 'Homey',
      RegControlAddr: [3000],
    });
  });
});

describe('buildSet', () => {
  it('builds a Set envelope with CommandSource Homey', () => {
    expect(
      buildSet('Energycontrolparameters', 3, {
        SetControlInfo: { '3000': '1' },
      })
    ).toEqual({
      Set: 'Energycontrolparameters',
      SerialNumber: 3,
      CommandSource: 'Homey',
      SetControlInfo: { '3000': '1' },
    });
  });
});

describe('encodeRequest', () => {
  it('appends a trailing newline to the JSON payload', () => {
    const buf = encodeRequest({ a: 1 });
    expect(buf.toString('utf-8')).toBe('{"a":1}\n');
  });

  it('returns a Buffer', () => {
    expect(Buffer.isBuffer(encodeRequest({}))).toBe(true);
  });
});

describe('JsonAccumulator', () => {
  it('returns null for a partial JSON payload', () => {
    const acc = new JsonAccumulator();
    expect(acc.push(Buffer.from('{"a":'))).toBeNull();
  });

  it('returns the parsed object once the JSON completes', () => {
    const acc = new JsonAccumulator();
    acc.push(Buffer.from('{"a":'));
    expect(acc.push(Buffer.from('1}'))).toEqual({ a: 1 });
  });

  it('reassembles a response split across three chunks', () => {
    const acc = new JsonAccumulator();
    expect(acc.push(Buffer.from('{"Storage'))).toBeNull();
    expect(acc.push(Buffer.from('_list":[1,2'))).toBeNull();
    expect(acc.push(Buffer.from(',3]}'))).toEqual({ Storage_list: [1, 2, 3] });
  });

  it('tracks byteLength across pushes', () => {
    const acc = new JsonAccumulator();
    acc.push(Buffer.from('{"a":'));
    acc.push(Buffer.from('1}'));
    expect(acc.byteLength).toBe(7);
  });

  it('truncates preview for logging beyond 200 chars', () => {
    const acc = new JsonAccumulator();
    acc.push(Buffer.from('{"a":"' + 'x'.repeat(300) + '"'));
    expect(acc.preview.length).toBe(203);
    expect(acc.preview.endsWith('...')).toBe(true);
  });

  it('does not truncate a short preview', () => {
    const acc = new JsonAccumulator();
    acc.push(Buffer.from('{"a":1}'));
    expect(acc.preview).toBe('{"a":1}');
  });

  it('reset clears accumulated bytes', () => {
    const acc = new JsonAccumulator();
    acc.push(Buffer.from('{"a":1}'));
    acc.reset();
    expect(acc.byteLength).toBe(0);
    expect(acc.push(Buffer.from('{"b":2}'))).toEqual({ b: 2 });
  });
});

describe('unwrapContainer', () => {
  it('returns null for a null/undefined response', () => {
    expect(unwrapContainer(null, 'control')).toBeNull();
    expect(unwrapContainer(undefined, 'control')).toBeNull();
  });

  it('cascades control: ControlInfo, then GetParameters, then Parameters', () => {
    expect(unwrapContainer({ ControlInfo: { a: 1 } }, 'control')).toEqual({
      a: 1,
    });
    expect(unwrapContainer({ GetParameters: { b: 2 } }, 'control')).toEqual({
      b: 2,
    });
    expect(unwrapContainer({ Parameters: { c: 3 } }, 'control')).toEqual({
      c: 3,
    });
    expect(
      unwrapContainer(
        { GetParameters: { b: 2 }, Parameters: { c: 3 } },
        'control'
      )
    ).toEqual({
      b: 2,
    });
  });

  it('cascades devicemanagement: DeviceManagementInfo, ControlInfo, Parameters, GetParameters', () => {
    expect(
      unwrapContainer({ DeviceManagementInfo: { a: 1 } }, 'devicemanagement')
    ).toEqual({
      a: 1,
    });
    expect(
      unwrapContainer({ Parameters: { c: 3 } }, 'devicemanagement')
    ).toEqual({ c: 3 });
    expect(
      unwrapContainer({ GetParameters: { d: 4 } }, 'devicemanagement')
    ).toEqual({ d: 4 });
  });

  it('finds DeviceManagement data arriving under ControlInfo (JET firmware quirk)', () => {
    expect(
      unwrapContainer({ ControlInfo: { '8': 'SN123' } }, 'devicemanagement')
    ).toEqual({
      '8': 'SN123',
    });
  });

  it('returns null when none of the container keys match', () => {
    expect(unwrapContainer({ SomethingElse: { a: 1 } }, 'control')).toBeNull();
  });

  it('skips array-valued keys and keeps cascading', () => {
    expect(
      unwrapContainer(
        { ControlInfo: [1, 2, 3], GetParameters: { a: 1 } },
        'control'
      )
    ).toEqual({
      a: 1,
    });
  });
});

describe('readRegister', () => {
  it('returns the string value for a present register', () => {
    expect(readRegister({ '3000': '1' }, '3000')).toBe('1');
  });

  it('coerces a numeric value to a string', () => {
    expect(readRegister({ '76': -55 }, '76')).toBe('-55');
  });

  it('returns undefined for a missing register', () => {
    expect(readRegister({ '3000': '1' }, '9999')).toBeUndefined();
  });

  it('returns undefined for a null params object', () => {
    expect(readRegister(null, '3000')).toBeUndefined();
    expect(readRegister(undefined, '3000')).toBeUndefined();
  });

  it('returns undefined for an explicit null register value', () => {
    expect(readRegister({ '3000': null }, '3000')).toBeUndefined();
  });
});
