// SPDX-License-Identifier: AGPL-3.0-or-later
// Conference rooms (03 §6.11): sp-conf-{id} asks for the PIN (3 tries) when the room has one; the
// admin PIN joins with sp_admin_user. Each room has its own bridge profile (max members):
// CONFBRIDGE(bridge,max_members) is ignored once ConfBridge() names a profile (seen in M8-T3). A recorded room records each caller's leg like a recorded
// call (from the moment they're in), so it lands in call history and Recordings.
// ponytail: one file per participant; a single file per meeting (record_conference) needs its
// own recordings row and retention.
import { byNumber, type Snapshot } from '../load.ts';
import * as s from '../sanitize.ts';

const bridgeProfile = (number: string) => `sp_room_${s.digits(number)}`;

/** confbridge_selfphoneng.conf: the admin user profile and one bridge profile per room. */
export function renderConfbridge(snap: Snapshot): string {
  return [
    '[sp_admin_user]',
    'type = user',
    'admin = yes',
    'marked = yes',
    'music_on_hold_when_empty = yes',
    ...[...snap.conferences]
      .sort(byNumber)
      .flatMap((c) => [
        '',
        `[${bridgeProfile(c.number)}](default_bridge)        ; room ${s.digits(c.number)}`,
        `max_members = ${s.digits(String(c.maxMembers))}`,
      ]),
    '',
  ].join('\n');
}

export function renderConferences(snap: Snapshot): string {
  return [...snap.conferences]
    .sort(byNumber)
    .map((c) => {
      const num = s.digits(c.number);
      /** Lines that put the caller in the room; `label` names the first one. */
      const enter = (label: string, profile: string) =>
        [
          ...(c.record ? ['Gosub(sp-sub-record,s,1)'] : []),
          `ConfBridge(${num},${bridgeProfile(num)},${profile},default_menu)`,
          'Hangup()',
        ].map((app, i) => ` same => n${i === 0 ? label : ''},${app}`);
      const lines = [
        `; ─── Conference room ${num} "${s.name(c.name)}"`,
        `[sp-conf-${s.ident(c.id)}]`,
        `exten => s,1,Set(__SP_TARGET=${num})`,
        ' same => n,Answer()',
      ];
      if (!c.pin) lines.push(...enter('', 'default_user'));
      else
        lines.push(
          ' same => n,Set(TRIES=0)',
          ' same => n(ask),Read(PIN,conf-getpin,10,,1,8)',
          ...(c.adminPin ? [` same => n,GotoIf($["\${PIN}" = "${s.pin(c.adminPin)}"]?admin)`] : []),
          ` same => n,GotoIf($["\${PIN}" = "${s.pin(c.pin)}"]?user)`,
          ' same => n,Set(TRIES=$[${TRIES} + 1])',
          ' same => n,GotoIf($[${TRIES} < 3]?bad)',
          ' same => n,Hangup()',
          ' same => n(bad),Playback(conf-invalidpin)',
          ' same => n,Goto(ask)',
          ...(c.adminPin ? enter('(admin)', 'sp_admin_user') : []),
          ...enter('(user)', 'default_user'),
        );
      return lines.join('\n') + '\n';
    })
    .join('\n');
}
