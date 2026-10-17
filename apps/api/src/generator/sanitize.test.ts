// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import * as s from './sanitize.ts';

const HOSTILE = [
  '101); System(rm -rf /',
  '101\n',
  '101\r\nexten => 1,1,System(x)',
  '',
  ' 101',
  '${SHELL(id)}',
  '１０１', // full-width digits
  '१२३', // Devanagari digits
  '101;comment',
  '1'.repeat(300),
];

describe('sanitizers reject hostile input', () => {
  const strict = [
    'digits',
    'dialable',
    'pattern',
    'sound',
    'ident',
    'secret',
    'pin',
    'host',
    'ipv4',
    'cidr',
  ] as const;
  for (const fn of strict) {
    it.each(HOSTILE)(`${fn}(%j) throws`, (v) => {
      expect(() => s[fn](v)).toThrow(s.SanitizeError);
    });
  }
});

describe('sanitizers accept good input', () => {
  it.each([
    ['digits', '13125551234'],
    ['dialable', '+4420794609*#'],
    ['pattern', '_NXXNXXXXXX'.slice(1)],
    ['pattern', '011.'],
    ['pattern', '1[2-9]XX!'],
    ['sound', 'custom/3f2a-bc_d'],
    ['ident', '3f2a1b4c-0000-4000-8000-000000000000'],
    ['secret', 'Ab3dEf9hIj2kLm4nOp6qRs8t'],
    ['pin', '1234'],
    ['pin', '0123456789'],
    ['host', 'chicago1.voip.ms'],
    ['host', '10.0.0.1'],
    ['ipv4', '203.0.113.7'],
    ['cidr', '192.168.0.0/16'],
  ] as const)('%s(%s)', (fn, v) => {
    expect(s[fn](v)).toBe(v);
  });

  it('rejects near misses', () => {
    expect(() => s.pin('123')).toThrow();
    expect(() => s.pin('12345678901')).toThrow();
    expect(() => s.ipv4('256.1.1.1')).toThrow();
    expect(() => s.cidr('10.0.0.0/33')).toThrow();
    expect(() => s.host('-bad.example')).toThrow();
    expect(() => s.sound('Custom/X')).toThrow();
    expect(() => s.ident('UPPER')).toThrow();
  });
});

describe('name()', () => {
  it.each([
    ['Dan Doe', 'Dan Doe'],
    ['  Dan  ', 'Dan'],
    ['x"); System(rm -rf /)', 'x Systemrm -rf /'],
    ["Robert'); DROP TABLE;--", 'Robert DROP TABLE--'],
    ['line\nbreak\r\nexten => 1,1,Hangup', 'linebreakexten => 11Hangup'.replace('=>', '=')],
    ['${SHELL(id)}', 'SHELLid'],
    ['a\u202Eb\u200Bc', 'abc'], // bidi override and zero-width space
    ['Zoë Ångström 李', 'Zoë Ångström 李'],
    ['x'.repeat(60), 'x'.repeat(40)],
  ])('%j → %j', (input, expected) => {
    expect(s.name(input)).toBe(expected);
  });
});
