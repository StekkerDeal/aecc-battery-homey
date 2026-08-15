import type { BrandId, Direction } from '../types';
import { slotField6 } from './brands';

export interface EncodeSlotInput {
  direction: Direction;
  /** Positive magnitude; sign is applied here based on direction. */
  powerW: number;
  brand: BrandId;
  field7: number;
  chargeSoc: number;
  dischargeSoc: number;
}

const SLOT_FIELD_COUNT = 11;

// The only place the sign convention flips: register field 3 is negative for
// charge, positive for discharge, the opposite of the Homey convention used
// everywhere above this module.
export function encodeSlot(input: EncodeSlotInput): string {
  const { direction, powerW, brand, field7, chargeSoc, dischargeSoc } = input;
  if (direction === 'idle' || powerW === 0) {
    return `0,00:00,00:00,0,0,0,0,0,0,${chargeSoc},${dischargeSoc}`;
  }
  const signed = direction === 'charge' ? -powerW : powerW;
  const field6 = slotField6(brand, field7);
  return `1,00:00,23:59,${signed},0,6,${field6},0,0,${chargeSoc},${dischargeSoc}`;
}

export interface DecodedSlot {
  direction: Direction;
  powerW: number;
}

export function decodeSlot(raw: string): DecodedSlot | null {
  const parts = raw.split(',');
  if (parts.length !== SLOT_FIELD_COUNT) return null;
  const field3 = parts[3];
  if (field3 === undefined || !/^-?\d+$/.test(field3)) return null;
  const value = Number(field3);
  if (value > 0) return { direction: 'discharge', powerW: value };
  if (value < 0) return { direction: 'charge', powerW: -value };
  return { direction: 'idle', powerW: 0 };
}
