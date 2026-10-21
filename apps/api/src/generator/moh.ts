// SPDX-License-Identifier: AGPL-3.0-or-later
// musiconhold_selfphoneng.conf (03 §8): one class per moh_classes row that has music, as a
// playlist in the order the admin set (owner, 2026-10-21), or shuffled. [default] lives in the
// static musiconhold.conf (01 §3.11).
import type { Snapshot } from './load.ts';
import * as s from './sanitize.ts';

export function renderMoh(snap: Snapshot): string {
  return [...snap.mohClasses]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) =>
      [
        `[${s.ident(c.name)}]`,
        'mode = playlist',
        // No extension: Asterisk picks the format, as it does for files mode.
        ...c.files.map((id) => `entry = /var/lib/asterisk/moh/${s.ident(c.name)}/${s.ident(id)}`),
        // Random picks each next file at random (res_musiconhold MOH_RANDOMIZE, any mode).
        ...(c.shuffle ? ['sort = random'] : []),
        '',
      ].join('\n'),
    )
    .join('\n');
}
