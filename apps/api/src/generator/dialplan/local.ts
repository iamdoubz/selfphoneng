// SPDX-License-Identifier: AGPL-3.0-or-later
// sp-local-numbers (03 §6.6) and the globals file (03 §6.3).
import { CLASS_RANK } from '@selfphoneng/shared';
import { byNumber, type Snapshot } from '../load.ts';
import * as s from '../sanitize.ts';

// TODO(M4): voicemail on. Until then every user gets ARG3 = 0 (09 M2-T4).
const VOICEMAIL_READY = false;

export function renderLocalNumbers(snap: Snapshot): string {
  const lines = [
    '[sp-local-numbers]',
    'include => sp-parkedcalls',
    '',
    '; users (sorted by number)',
  ];
  for (const e of [...snap.extensions].sort(byNumber)) {
    const num = s.digits(e.number);
    const ring = s.digits(String(e.ringSeconds));
    const vm = VOICEMAIL_READY && e.voicemailEnabled ? 1 : 0;
    lines.push(
      `exten => ${num},1,Gosub(sp-sub-user,s,1(${num},${ring},${vm},${e.recordMode}))`,
      ' same => n,Hangup()',
      `exten => ${num},hint,PJSIP/${num}${e.webrtcEnabled ? `&PJSIP/${num}-web` : ''}`,
    );
  }
  // M6/M8: ring groups, queues, IVRs, conferences and paging groups add one line each here.
  return lines.join('\n') + '\n';
}

export function renderGlobals(snap: Snapshot): string {
  const st = snap.settings;
  const didNumber = (id: string | null) => {
    const d = id ? snap.dids.find((x) => x.id === id) : undefined;
    return d ? s.digits(d.number) : '';
  };
  const defaultCid = didNumber(st['routing.defaultCallerIdDidId']);
  const lines = [
    `SP_DEFAULT_CID=${defaultCid}`,
    `SP_DEFAULT_E911_CID=${didNumber(st['emergency.defaultCallerIdDidId']) || defaultCid}`,
    'SP_REC_ANNOUNCE=', // M7: recordings.announcementSoundId → sound name
  ];
  const exts = [...snap.extensions].sort(byNumber);
  for (const e of exts) lines.push(`SP_CLASS_${s.digits(e.number)}=${CLASS_RANK[e.outboundClass]}`);
  for (const e of exts) if (e.isAdmin) lines.push(`SP_TCADMIN_${s.digits(e.number)}=1`);
  return lines.join('\n') + '\n';
}
