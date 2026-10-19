// SPDX-License-Identifier: AGPL-3.0-or-later
// Golden tests (03 §12.1–12.2): render(snapshot.json) must equal expected/*.conf byte for byte.
// `UPDATE_GOLDEN=1 pnpm test` rewrites the expected files; a human reads the diff before committing.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GOLDEN_ROOT as ROOT, loadCase } from './golden-case.ts';
import { GENERATED_FILES, render } from './index.ts';

const UPDATE = process.env.UPDATE_GOLDEN === '1';

const cases = readdirSync(ROOT).filter((d) => existsSync(join(ROOT, d, 'snapshot.json')));

describe('golden', () => {
  it('has the required cases', () => {
    // 03 §12.1; the rest arrive with their features (M6, M8).
    expect(cases).toEqual(
      expect.arrayContaining([
        'empty',
        'one-user',
        'webrtc-disabled',
        'hostile-names',
        'voipms-basic',
        'ringgroups',
        'ivr',
        'holidays',
        'ivr-business-hours',
        'queue',
        'conferences',
      ]),
    );
  });

  describe.each(cases)('%s', (name) => {
    const snap = loadCase(name);
    const files = render(snap);
    const dir = join(ROOT, name, 'expected');
    if (UPDATE) {
      mkdirSync(dir, { recursive: true });
      for (const f of GENERATED_FILES) writeFileSync(join(dir, f), files[f]);
    }
    it.each(GENERATED_FILES)('%s', (f) => {
      expect(files[f]).toBe(readFileSync(join(dir, f), 'utf8'));
    });

    it('is deterministic: shuffled input order gives identical output', () => {
      const shuffled = {
        ...snap,
        extensions: [...snap.extensions].reverse(),
        queues: [...snap.queues]
          .reverse()
          .map((q) => ({ ...q, members: [...q.members].reverse() })),
      };
      expect(render(shuffled)).toEqual(files);
    });
  });
});
