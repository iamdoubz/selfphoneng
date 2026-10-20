// SPDX-License-Identifier: AGPL-3.0-or-later
// Outside calls at once (08 §1): the lines in each sp-route-* for calls.maxPerExtension and
// calls.maxTotal, 0 = no limit. trunk-test.ts checks them on a real Asterisk.
import { describe, expect, it } from 'vitest';
import { loadCase } from './golden-case.ts';
import { render } from './index.ts';

const route = (perExt: number, total: number) => {
  const snap = loadCase('voipms-basic');
  snap.settings['calls.maxPerExtension'] = perExt;
  snap.settings['calls.maxTotal'] = total;
  const conf = render(snap)['extensions_selfphoneng.conf'];
  const start = conf.indexOf('[sp-route-');
  return conf.slice(start, conf.indexOf('\n[', start + 1));
};

describe('call limits', () => {
  it('both: per extension, then the total', () => {
    const r = route(3, 10);
    expect(r).toContain('GotoIf($[${GROUP_COUNT(${SP_LIMITEXT}@spext)} > 3]?busy)');
    expect(r).toContain('GotoIf($["${SP_LIMITEXT}" = ""]?total)');
    expect(r).toContain(' same => n(total),Set(GROUP(spout)=all)');
    expect(r).toContain('GotoIf($[${GROUP_COUNT(all@spout)} > 10]?busy)');
    expect(r.indexOf('@spext')).toBeLessThan(r.indexOf('Dial('));
  });

  it('per extension only: a call with no extension skips to the end of the check', () => {
    const r = route(2, 0);
    expect(r).toContain('GotoIf($["${SP_LIMITEXT}" = ""]?counted)');
    expect(r).toContain(' same => n(counted),NoOp()');
    expect(r).not.toContain('spout');
  });

  it('total only, and neither', () => {
    expect(route(0, 5)).not.toContain('spext');
    expect(route(0, 5)).toContain(' same => n,Set(GROUP(spout)=all)');
    expect(route(0, 0)).not.toMatch(/spext|spout|SP_LIMITEXT/);
  });

  it("a forward counts toward the forwarding extension's limit", () => {
    expect(render(loadCase('voipms-basic'))['extensions_selfphoneng.conf']).toContain(
      ' same => n,Set(SP_LIMITEXT=${ARG2})',
    );
  });
});
