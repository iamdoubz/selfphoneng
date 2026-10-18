// SPDX-License-Identifier: AGPL-3.0-or-later
// 911 (03 §6.14). Never blocked for any reason: no class check, no channel limits, no DND, and
// every enabled trunk is tried. The UserEvent makes the api notify people (04 §5.3).
import type { Snapshot } from '../load.ts';
import * as s from '../sanitize.ts';

export function renderEmergency(snap: Snapshot): string {
  const trunks = snap.trunks
    .filter((t) => t.enabled)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return (
    [
      '[sp-emergency-dial]',
      'exten => 911,1,Goto(sp-emergency,s,1)',
      'exten => 9911,1,Goto(sp-emergency,s,1)          ; people who dial 9 first out of habit',
      '',
      '[sp-emergency]',
      'exten => s,1,Set(CID=${IF($["${SP_E911CID}" != ""]?${SP_E911CID}:${SP_DEFAULT_E911_CID})})',
      ' same => n,UserEvent(SpEmergency,Ext: ${SP_EXT},CallerId: ${CID},Dialed: 911)',
      ' same => n,ExecIf($["${CID}" != ""]?Set(CALLERID(num)=${CID}))',
      ' same => n,Set(__SP_DIRECTION=outbound)',
      ...trunks.map((t) => ` same => n,Dial(PJSIP/911@trunk-${s.ident(t.id)})`),
      ' same => n,Hangup()',
    ].join('\n') + '\n'
  );
}
