// SPDX-License-Identifier: AGPL-3.0-or-later
// M11-T8: a caller in a digital receptionist with direct dial on reaches people, groups, queues,
// rooms and other menus, but not paging groups (the office speakers) or parked calls.
import { describe, expect, it } from 'vitest';
import { loadCase } from './golden-case.ts';
import { render } from './index.ts';

const context = (conf: string, name: string) => {
  const start = conf.indexOf(`[${name}]\n`);
  const end = conf.indexOf('\n[', start + 1);
  return conf.slice(start, end === -1 ? undefined : end);
};

describe('IVR direct dial', () => {
  const snap = loadCase('ivr');
  snap.pagingGroups = loadCase('paging').pagingGroups;
  const conf = render(snap)['extensions_selfphoneng.conf'];
  const direct = context(conf, 'sp-ivr-direct');
  const page = snap.pagingGroups[0]!.number;

  it('the menu includes sp-ivr-direct, not sp-local-numbers', () => {
    expect(conf).toContain('include => sp-ivr-direct');
    expect(conf).not.toMatch(/\[sp-ivr-[0-9a-f-]+\]\ninclude => sp-local-numbers/);
  });

  it('lists users, ring groups and menus, but no paging group or parking lot', () => {
    for (const n of [...snap.extensions, ...snap.ringGroups, ...snap.ivrs].map((x) => x.number))
      expect(direct).toContain(`exten => ${n},1,Goto(sp-local-numbers,${n},1)`);
    expect(context(conf, 'sp-local-numbers')).toContain(`exten => ${page},1,`);
    expect(direct).not.toContain(`exten => ${page},`);
    expect(direct).not.toContain('parkedcalls');
  });
});
