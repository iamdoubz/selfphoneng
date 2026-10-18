// SPDX-License-Identifier: AGPL-3.0-or-later
// Announcements (03 §6.11): play a sound, then continue.
import type { Snapshot } from '../load.ts';
import * as s from '../sanitize.ts';
import { destApp } from './inbound.ts';

export function renderAnnouncements(snap: Snapshot): string {
  return [...snap.announcements]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((a) =>
      [
        `; ─── Announcement "${s.name(a.name)}"`,
        `[sp-ann-${s.ident(a.id)}]`,
        'exten => s,1,Answer()',
        ` same => n,Playback(${s.sound(a.sound)})`,
        ` same => n,${destApp(a.destination, snap)}`,
        '',
      ].join('\n'),
    )
    .join('\n');
}
