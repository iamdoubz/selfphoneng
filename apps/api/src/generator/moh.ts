// SPDX-License-Identifier: AGPL-3.0-or-later
// musiconhold_selfphoneng.conf (03 §8): one class per moh_classes row, a folder Asterisk plays in
// random order. [default] lives in the static musiconhold.conf (01 §3.11).
import type { Snapshot } from './load.ts';
import * as s from './sanitize.ts';

export function renderMoh(snap: Snapshot): string {
  return [...snap.mohClasses]
    .sort()
    .map((name) =>
      [
        `[${s.ident(name)}]`,
        'mode = files',
        `directory = /var/lib/asterisk/moh/${s.ident(name)}`,
        'sort = random',
        '',
      ].join('\n'),
    )
    .join('\n');
}
