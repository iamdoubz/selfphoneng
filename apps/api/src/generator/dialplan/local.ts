// SPDX-License-Identifier: AGPL-3.0-or-later
// sp-local-numbers (03 §6.6) and the globals file (03 §6.3).
import { CLASS_RANK } from '@selfphoneng/shared';
import { byNumber, type Snapshot } from '../load.ts';
import * as s from '../sanitize.ts';

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
    const vm = e.voicemailEnabled ? 1 : 0;
    lines.push(
      `exten => ${num},1,Gosub(sp-sub-user,s,1(${num},${ring},${vm},${e.recordMode}))`,
      ' same => n,Hangup()',
      `exten => ${num},hint,PJSIP/${num}${e.webrtcEnabled ? `&PJSIP/${num}-web` : ''}`,
    );
  }
  if (snap.ringGroups.length) lines.push('', '; ring groups');
  for (const g of [...snap.ringGroups].sort(byNumber))
    lines.push(`exten => ${s.digits(g.number)},1,Goto(sp-rg-${s.ident(g.id)},s,1)`);
  if (snap.queues.length) lines.push('', '; queues');
  for (const q of [...snap.queues].sort(byNumber))
    lines.push(`exten => ${s.digits(q.number)},1,Goto(sp-queue-${s.ident(q.id)},s,1)`);
  if (snap.conferences.length) lines.push('', '; conference rooms');
  for (const c of [...snap.conferences].sort(byNumber))
    lines.push(`exten => ${s.digits(c.number)},1,Goto(sp-conf-${s.ident(c.id)},s,1)`);
  if (snap.ivrs.length) lines.push('', '; digital receptionists');
  for (const r of [...snap.ivrs].sort(byNumber))
    lines.push(`exten => ${s.digits(r.number)},1,Goto(sp-ivr-${s.ident(r.id)},s,1)`);
  if (snap.pagingGroups.length) lines.push('', '; paging groups');
  for (const g of [...snap.pagingGroups].sort(byNumber))
    lines.push(`exten => ${s.digits(g.number)},1,Goto(sp-page-${s.ident(g.id)},s,1)`);
  return lines.join('\n') + '\n';
}

/**
 * sp-ivr-direct (03 §6.9): what a caller in a digital receptionist may dial. Not paging groups
 * (an outside caller on the office speakers) and not parked calls (someone else's call), M11-T8.
 */
export function renderIvrDirect(snap: Snapshot): string {
  if (!snap.ivrs.some((r) => r.allowDirectDial)) return '';
  const nums = [
    ...snap.extensions,
    ...snap.ringGroups,
    ...snap.queues,
    ...snap.conferences,
    ...snap.ivrs,
  ].sort(byNumber);
  return (
    [
      '[sp-ivr-direct]',
      ...nums
        .map((x) => s.digits(x.number))
        .map((n) => `exten => ${n},1,Goto(sp-local-numbers,${n},1)`),
    ].join('\n') + '\n'
  );
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
    `SP_REC_ANNOUNCE=${snap.recordingAnnouncement ? s.sound(snap.recordingAnnouncement) : ''}`,
    // Spec 10 §3: also record each side on its own, for the transcript job.
    `SP_REC_SIDES=${st['ai.callTranscripts'] && st['ai.stt'] ? '1' : ''}`,
  ];
  const exts = [...snap.extensions].sort(byNumber);
  for (const e of exts) lines.push(`SP_CLASS_${s.digits(e.number)}=${CLASS_RANK[e.outboundClass]}`);
  for (const e of exts) if (e.isAdmin) lines.push(`SP_TCADMIN_${s.digits(e.number)}=1`);
  return lines.join('\n') + '\n';
}
