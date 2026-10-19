// SPDX-License-Identifier: AGPL-3.0-or-later
// voicemail_selfphoneng.conf (03 §7). Asterisk only records; the api indexes and emails (04 §5.6).
import { byNumber, type Snapshot } from './load.ts';
import * as s from './sanitize.ts';

export function renderVoicemail(snap: Snapshot): string {
  const st = snap.settings;
  const boxes = [...snap.extensions]
    .filter((e) => e.voicemailEnabled)
    .sort(byNumber)
    .map((e) => {
      const num = s.digits(e.number);
      return `${num} => ${s.pin(e.voicemailPin)},${s.name(e.name) || num},,,tz=local|attach=no`;
    });
  return `[general]
format = wav
attach = no                 ; the api sends emails itself
maxmsg = ${s.digits(String(st['voicemail.maxMessages']))}
maxsecs = ${s.digits(String(st['voicemail.maxMessageSeconds']))}
minsecs = 1
maxsilence = 10
silencethreshold = 128
maxlogins = 3
minpassword = 4
; PINs changed from the phone pass the api's rules first (asterisk/sp-vm-pincheck); the api
; stores them from VoicemailPasswordChange (services/vmpin.ts).
externpasscheck = /usr/local/bin/sp-vm-pincheck
envelope = yes
saycid = yes
review = no
nextaftercmd = yes
sendvoicemail = no
pollmailboxes = yes
pollfreq = 30

[zonemessages]
local = ${s.timezone(st['general.timezone'])}|'vm-received' Q 'digits/at' IMp

[default]
${boxes.join('\n')}
`;
}
