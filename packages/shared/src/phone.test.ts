// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { formatNumber, isReservedNumber, normalizeNumber } from './phone.ts';

describe('normalizeNumber', () => {
  it.each([
    ['+1 (312) 555-1234', '13125551234'],
    ['+13125551234', '13125551234'],
    ['3125551234', '13125551234'],
    ['13125551234', '13125551234'],
    ['(312) 555-1234', '13125551234'],
    ['312.555.1234', '13125551234'],
    ['312-555-1234', '13125551234'],
    ['  312 555 1234  ', '13125551234'],
    ['8005551234', '18005551234'],
    ['+44 20 7946 0958', '011442079460958'],
    ['+33 1 23 45 67 89', '01133123456789'],
    ['011442079460958', '011442079460958'],
    ['*97', '*97'],
    ['*72101', '*72101'],
    ['**101', '**101'],
    ['#', '#'],
    ['911', '911'],
    ['101', '101'],
    ['0', '0'],
    ['5551234', '5551234'],
    ['1234567890', '1234567890'], // 10 digits starting with 1 is not NANP: left as-is
  ])('%j → %s', (input, expected) => {
    expect(normalizeNumber(input)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    'abc',
    '312-555-CALL',
    '+',
    '+1',
    '+1312555123',
    '+131255512345',
    '+44abc',
    '12+34',
    '101); System(rm -rf /',
    '१२३',
  ])('rejects %j', (input) => {
    expect(() => normalizeNumber(input)).toThrow();
  });
});

describe('formatNumber', () => {
  it.each([
    ['13125551234', '(312) 555-1234'],
    ['18005551234', '(800) 555-1234'],
    ['101', '101'],
    ['011442079460958', '011442079460958'],
    ['*97', '*97'],
  ])('%s → %s', (input, expected) => {
    expect(formatNumber(input)).toBe(expected);
  });
});

describe('isReservedNumber', () => {
  it.each(['211', '311', '411', '511', '611', '711', '811', '911', '933', '0123', '1000', '10000'])(
    '%s is reserved',
    (n) => {
      expect(isReservedNumber(n)).toBe(true);
    },
  );
  it.each(['100', '101', '499', '500', '700', '912', '011', '2000'])('%s is free', (n) => {
    expect(isReservedNumber(n)).toBe(false);
  });
});
