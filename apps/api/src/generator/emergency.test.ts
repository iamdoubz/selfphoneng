// SPDX-License-Identifier: AGPL-3.0-or-later
// M3-T4 (06 §6.1): 911 can't be blocked. An extension with class internal, DND on and every trunk
// at its channel limit still reaches the 911 Dial lines.
import { describe, expect, it } from 'vitest';
import { loadCase } from './golden-case.ts';
import { render } from './index.ts';

const context = (conf: string, name: string) => {
  const start = conf.indexOf(`[${name}]\n`);
  const end = conf.indexOf('\n[', start + 1);
  return conf.slice(start, end === -1 ? undefined : end);
};

describe('emergency dialplan', () => {
  const snap = loadCase('voipms-basic');
  snap.extensions[0]!.outboundClass = 'internal';
  snap.trunks.push({
    ...snap.trunks[0]!,
    id: 'b0b0b0b0-0000-4000-8000-000000000000',
    name: 'b',
    maxChannels: 1,
  });
  snap.trunks.push({
    ...snap.trunks[0]!,
    id: 'c0c0c0c0-0000-4000-8000-000000000000',
    name: 'c',
    enabled: false,
  });
  const conf = render(snap)['extensions_selfphoneng.conf'];

  it('911 and 9911 are matched before anything else a phone can dial', () => {
    expect(context(conf, 'sp-from-ext').split('\n')[1]).toBe('include => sp-emergency-dial');
    expect(context(conf, 'sp-emergency-dial')).toContain('exten => 911,1,Goto(sp-emergency,s,1)');
    expect(context(conf, 'sp-emergency-dial')).toContain('exten => 9911,1,Goto(sp-emergency,s,1)');
  });

  it('has no class, DND or channel-limit check, and dials every enabled trunk in name order', () => {
    const e = context(conf, 'sp-emergency');
    expect(e).not.toMatch(/SP_CLASS|DND|GROUP|denied|ss-noservice/);
    expect([...e.matchAll(/Dial\(PJSIP\/911@trunk-([0-9a-f-]+)\)/g)].map((m) => m[1])).toEqual([
      'b0b0b0b0-0000-4000-8000-000000000000', // "b"
      '7d3e9a52-1c4b-4f6e-9a0d-2b8c5e1f4a37', // "voip.ms"; the disabled "c" is left out
    ]);
    expect(e).toContain('UserEvent(SpEmergency,Ext: ${SP_EXT},CallerId: ${CID},Dialed: 911)');
  });

  it('sends the E911 caller ID: the extension one, else the system default', () => {
    expect(context(conf, 'sp-emergency')).toContain(
      'Set(CID=${IF($["${SP_E911CID}" != ""]?${SP_E911CID}:${SP_DEFAULT_E911_CID})})',
    );
    expect(render(snap)['extensions_globals_selfphoneng.conf']).toContain(
      'SP_DEFAULT_E911_CID=13125551234',
    );
  });

  it('still notifies when there is no trunk at all', () => {
    const none = { ...snap, trunks: [], routes: [] };
    const e = context(render(none)['extensions_selfphoneng.conf'], 'sp-emergency');
    expect(e).toContain('UserEvent(SpEmergency');
    expect(e).not.toContain('Dial(');
  });
});
