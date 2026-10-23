// SPDX-License-Identifier: AGPL-3.0-or-later
// Ring groups (03 §6.7). Members ring through sp-rg-member, which skips DND and ignores the
// member's forwarding and voicemail on purpose; unanswered calls go to the group's destination.
import { byNumber, type Snapshot } from '../load.ts';
import * as s from '../sanitize.ts';
import { destApp } from './inbound.ts';

export function renderRingGroups(snap: Snapshot): string {
  return [...snap.ringGroups]
    .sort(byNumber)
    .map((g) => {
      const num = s.digits(g.number);
      const secs = s.digits(String(g.ringSeconds));
      const opts = g.musicInsteadOfRing ? 'tm' : 't';
      const dial = (members: string[]) =>
        [
          ` same => n,Dial(${members.map((m) => `Local/${s.digits(m)}@sp-rg-member`).join('&')},${secs},${opts})`,
          ' same => n,GotoIf($["${DIALSTATUS}" = "ANSWER"]?done)',
        ].join('\n');
      const prefix = g.callerIdNamePrefix ? s.name(g.callerIdNamePrefix) : '';
      return [
        `; ─── Ring group ${num} "${s.name(g.name)}" (${g.strategy})`,
        `[sp-rg-${s.ident(g.id)}]`,
        `exten => s,1,Set(__SP_TARGET=${num})`,
        ...(prefix
          ? [
              ` same => n,Set(CALLERID(name)=${prefix} \${CALLERID(name)})`,
              // …and before a contact's name on ringing phones (sp-sub-dial-user, 11 §6 C4).
              ` same => n,Set(__SP_CNAM_PREFIX=${prefix} \${SP_CNAM_PREFIX})`,
            ]
          : []),
        ...(g.members.length === 0
          ? []
          : g.strategy === 'ringall'
            ? [dial(g.members)]
            : g.members.map((m) => dial([m]))),
        ` same => n,${destApp(g.noAnswerDestination, snap)}`,
        ' same => n(done),Hangup()',
        '',
      ].join('\n');
    })
    .join('\n');
}
