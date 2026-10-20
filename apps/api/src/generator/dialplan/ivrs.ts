// SPDX-License-Identifier: AGPL-3.0-or-later
// Digital receptionists (03 §6.9): play the greeting, wait for a key, retry on a wrong key or
// silence, then give up to the invalid/timeout destination.
import { byNumber, type Snapshot } from '../load.ts';
import * as s from '../sanitize.ts';
import { destApp } from './inbound.ts';

/** "Try again" on a wrong key or silence, then give up to `dest` after max_retries. */
const retry = (exten: 'i' | 't', max: number, then: string, sound?: string) =>
  [
    `exten => ${exten},1,Set(SP_IVR_TRIES=$[\${SP_IVR_TRIES} + 1])`,
    ` same => n,GotoIf($[\${SP_IVR_TRIES} >= ${max}]?giveup)`,
    ...(sound ? [` same => n,Playback(${sound})`] : []),
    ' same => n,Goto(s,menu)',
    ` same => n(giveup),${then}`,
  ].join('\n');

export function renderIvrs(snap: Snapshot): string {
  return [...snap.ivrs]
    .sort(byNumber)
    .map((r) => {
      const max = s.digits(String(r.maxRetries));
      return [
        `; ─── Digital receptionist ${s.digits(r.number)} "${s.name(r.name)}"`,
        `[sp-ivr-${s.ident(r.id)}]`,
        ...(r.allowDirectDial ? ['include => sp-ivr-direct'] : []),
        'exten => s,1,Answer()',
        ' same => n,Set(SP_IVR_TRIES=0)',
        ' same => n(menu),Set(TIMEOUT(digit)=3)',
        ` same => n,Background(${s.sound(r.greeting)})`,
        ` same => n,WaitExten(${s.digits(String(r.timeoutSeconds))})`,
        ...[...r.options]
          .sort((a, b) => a.digit.localeCompare(b.digit))
          .map((o) => `exten => ${s.ivrDigit(o.digit)},1,${destApp(o.destination, snap)}`),
        retry(
          'i',
          Number(max),
          destApp(r.invalidDestination, snap),
          s.sound(r.invalidSound ?? 'pbx-invalid'),
        ),
        retry('t', Number(max), destApp(r.timeoutDestination, snap)),
        '',
      ].join('\n');
    })
    .join('\n');
}
