// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AmiParser, field, fields, serialize } from './events.ts';

// Raw bytes Asterisk 24.0.0-rc2 sent for: Login, Command, CoreShowChannels, PJSIPShowContacts (none),
// ExtensionStateList, Command (multi-line), DBGet (missing), Ping, an unknown action.
const SESSION = readFileSync(
  new URL('../../test/fixtures/ami/asterisk-24-session.raw', import.meta.url),
  'latin1',
);

const parseAll = (chunks: string[]) => {
  const p = new AmiParser();
  return { msgs: chunks.flatMap((c) => p.push(c)), banner: p.banner };
};

describe('AmiParser', () => {
  const whole = parseAll([SESSION]);

  it('reads the banner and every message of a real session', () => {
    expect(whole.banner).toBe('Asterisk Call Manager/13.0.0');
    const byId = (id: string) => whole.msgs.filter((m) => m.ActionID === id);
    expect(byId('sp-1')[0]).toMatchObject({
      Response: 'Success',
      Message: 'Authentication accepted',
    });
    expect(field(byId('sp-2')[0]!, 'Output')).toMatch(/^Asterisk 24\./);
    expect(byId('sp-3').map((m) => m.EventList)).toEqual(['start', 'Complete']);
    // Asterisk ends this value with a bare LF.
    expect(byId('sp-4')[0]).toEqual({
      Response: 'Error',
      ActionID: 'sp-4',
      Message: 'No Contacts found',
    });
    expect(byId('sp-5').filter((m) => m.Event === 'ExtensionStatus')).toHaveLength(20);
    expect(fields(byId('sp-6')[0]!, 'Output')).toHaveLength(3);
    expect(byId('sp-8')[0]).toMatchObject({ Ping: 'Pong' });
    expect(byId('sp-9')[0]!.Response).toBe('Error');
  });

  it('gives the same result for any TCP chunking', () => {
    const oneByte = parseAll(SESSION.split(''));
    expect(oneByte).toEqual(whole);
    for (const size of [2, 3, 7, 50, 333]) {
      const chunks: string[] = [];
      for (let i = 0; i < SESSION.length; i += size) chunks.push(SESSION.slice(i, i + size));
      expect(parseAll(chunks)).toEqual(whole);
    }
    // Two messages and part of a third in one chunk.
    const p = new AmiParser();
    const msgs = p.push(
      'Asterisk Call Manager/13.0.0\r\nEvent: A\r\n\r\nEvent: B\r\nX: 1\r\n\r\nEvent: C\r\n',
    );
    expect(msgs.map((m) => m.Event)).toEqual(['A', 'B']);
    expect(p.push('\r\n').map((m) => m.Event)).toEqual(['C']);
  });

  it('keeps colons inside values and turns repeated keys into arrays', () => {
    const [m] = new AmiParser().push(
      'Asterisk Call Manager/13.0.0\r\nEvent: VarSet\r\nValue: a: b: c\r\nChanVariable: x=1\r\nChanVariable: y=2\r\n\r\n',
    );
    expect(m).toEqual({ Event: 'VarSet', Value: 'a: b: c', ChanVariable: ['x=1', 'y=2'] });
  });

  it('serializes actions and refuses header injection', () => {
    expect(serialize({ Action: 'Ping', ActionID: 'sp-1' })).toBe(
      'Action: Ping\r\nActionID: sp-1\r\n\r\n',
    );
    expect(() => serialize({ Action: 'Command', Command: 'x\r\nAction: Logoff' })).toThrow();
    expect(() => serialize({ Action: 'Command', Command: 'x\ny' })).toThrow();
  });
});
