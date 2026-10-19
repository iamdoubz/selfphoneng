// SPDX-License-Identifier: AGPL-3.0-or-later
// Paging groups (03 §6.11): sp-page-{id} calls every member's desk phone (PJSIP/<ext>, never -web)
// with the auto-answer headers. `s` skips phones that are in use, the pager's own included; `d`
// lets the paged phones talk back (intercom).
import { byNumber, type Snapshot } from '../load.ts';
import * as s from '../sanitize.ts';

export function renderPaging(snap: Snapshot): string {
  return [...snap.pagingGroups]
    .sort(byNumber)
    .map((g) => {
      const phones = [...g.members]
        .sort((a, b) => Number(a) - Number(b))
        .map((n) => `PJSIP/${s.digits(n)}`);
      const lines = [
        `; ─── Paging group ${s.digits(g.number)} "${s.name(g.name)}"`,
        `[sp-page-${s.ident(g.id)}]`,
      ];
      if (!phones.length) lines.push('exten => s,1,Hangup()                ; no members');
      else
        lines.push(
          `exten => s,1,Page(${phones.join('&')},${g.duplex ? 'd' : ''}iqsb(sp-sub-autoanswer^s^1),30)`,
          ' same => n,Hangup()',
        );
      return lines.join('\n') + '\n';
    })
    .join('\n');
}
