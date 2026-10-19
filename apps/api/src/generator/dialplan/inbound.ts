// SPDX-License-Identifier: AGPL-3.0-or-later
// Calls from trunks (03 §6.4, §6.5) and where destinations go (03 §6.0).
import type { Destination } from '@selfphoneng/shared';
import type { Snapshot } from '../load.ts';
import * as s from '../sanitize.ts';

/** ONE dialplan application that sends the call to `d` (03 §6.0). */
export function destApp(d: Destination, snap: Snapshot): string {
  switch (d.type) {
    case 'user':
    case 'voicemail': {
      const e = snap.extensions.find((x) => x.id === d.id);
      if (!e) return 'Hangup()'; // can't happen: the API refuses dangling destinations (02 §1)
      return `Goto(${d.type === 'user' ? 'sp-local-numbers' : 'sp-vm-direct'},${s.digits(e.number)},1)`;
    }
    case 'external':
      return `Goto(sp-ext-forward,${s.dialable(d.number)},1)`;
    case 'hangup':
      return 'Hangup()';
    case 'ring_group':
      return snap.ringGroups.some((g) => g.id === d.id)
        ? `Goto(sp-rg-${s.ident(d.id)},s,1)`
        : 'Hangup()';
    case 'queue':
      return snap.queues.some((q) => q.id === d.id)
        ? `Goto(sp-queue-${s.ident(d.id)},s,1)`
        : 'Hangup()';
    case 'conference':
      return snap.conferences.some((c) => c.id === d.id)
        ? `Goto(sp-conf-${s.ident(d.id)},s,1)`
        : 'Hangup()';
    case 'ivr':
      return snap.ivrs.some((r) => r.id === d.id)
        ? `Goto(sp-ivr-${s.ident(d.id)},s,1)`
        : 'Hangup()';
    case 'time_condition':
      return snap.timeConditions.some((t) => t.id === d.id)
        ? `Goto(sp-tc-${s.ident(d.id)},s,1)`
        : 'Hangup()';
    case 'announcement':
      return snap.announcements.some((a) => a.id === d.id)
        ? `Goto(sp-ann-${s.ident(d.id)},s,1)`
        : 'Hangup()';
    default:
      return 'Hangup()';
  }
}

/** One entry context per enabled trunk. */
export function renderTrunkEntries(snap: Snapshot): string {
  return snap.trunks
    .filter((t) => t.enabled)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((t) => {
      const ctx = `sp-from-trunk-${s.ident(t.id)}`;
      return (
        [
          `; ─── Calls from trunk "${s.name(t.name)}"`,
          `[${ctx}]`,
          `exten => s,1,Goto(${ctx},unknown,1)`,
          'exten => _[+0-9a-zA-Z].,1,Set(__SP_DIRECTION=inbound)',
          // cdr_manager [mappings] read CDR variables, not channel ones (04 §5.4).
          ' same => n,Set(CDR(SP_DIRECTION)=inbound)',
          ' same => n,Gosub(sp-sub-normalize,s,1(${EXTEN}))',
          ' same => n,Set(SP_IN=${GOSUB_RETVAL})',
          ' same => n,GotoIf($["${SP_IN}" != "" & ${DIALPLAN_EXISTS(sp-did-exists,${SP_IN},1)}]?caller)',
          " ; Request-URI didn't hold one of our DIDs: try the To header (06 §3)",
          ' same => n,Set(TOU=${CUT(CUT(PJSIP_HEADER(read,To),@,1),:,2)})',
          ' same => n,Gosub(sp-sub-normalize,s,1(${TOU}))',
          ' same => n,Set(SP_IN=${GOSUB_RETVAL})',
          ' same => n(caller),Gosub(sp-sub-normalize,s,1(${CALLERID(num)}))',
          ' same => n,Set(CALLERID(num)=${GOSUB_RETVAL})',
          ' same => n,GotoIf($["${DB(SP/BLOCK/${CALLERID(num)})}" = "1"]?blocked)',
          ' same => n,Goto(sp-inbound,${IF($["${SP_IN}" = ""]?unknown:${SP_IN})},1)',
          ' same => n(blocked),Hangup(21)',
        ].join('\n') + '\n'
      );
    })
    .join('\n');
}

/** sp-did-exists (left out when there are no DIDs: Asterisk won't create an empty context). */
export function renderDids(snap: Snapshot): string {
  const dids = [...snap.dids].sort((a, b) => a.number.localeCompare(b.number));
  const out: string[] = [];
  if (dids.length)
    out.push(
      ['[sp-did-exists]', ...dids.map((d) => `exten => ${s.digits(d.number)},1,NoOp()`)].join('\n'),
    );
  const inbound = ['[sp-inbound]'];
  for (const d of dids) {
    const num = s.digits(d.number);
    const prefix = d.callerIdNamePrefix ? s.name(d.callerIdNamePrefix) : '';
    inbound.push(
      `; DID ${num}${d.label ? ` "${s.name(d.label)}"` : ''}`,
      `exten => ${num},1,Set(__SP_DID=${num})`,
      ` same => n,Set(CDR(SP_DID)=${num})`,
      ...(prefix ? [` same => n,Set(CALLERID(name)=${prefix} \${CALLERID(name)})`] : []),
      // Recorded number: the caller hears the notice (if set) before the recording starts.
      ...(d.recordInbound && snap.recordingAnnouncement
        ? [' same => n,Answer()', ` same => n,Playback(${s.sound(snap.recordingAnnouncement)})`]
        : []),
      ...(d.recordInbound ? [' same => n,Gosub(sp-sub-record,s,1)'] : []),
      ` same => n,${destApp(d.destination, snap)}`,
    );
  }
  inbound.push(
    '; anything else',
    `exten => _[0-9a-z].,1,${destApp(snap.settings['routing.unmatchedDidDestination'], snap)}`,
  );
  out.push(inbound.join('\n'));
  return out.join('\n\n') + '\n';
}
