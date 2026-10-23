// SPDX-License-Identifier: AGPL-3.0-or-later
// Queue entry contexts (03 §6.8): answer, wait in the queue up to max_wait_seconds, and send
// callers who time out (or find no agents, or a full queue) to the timeout destination.
import { byNumber, type Snapshot } from '../load.ts';
import * as s from '../sanitize.ts';
import { destApp } from './inbound.ts';

const FAILED = ['TIMEOUT', 'FULL', 'JOINEMPTY', 'LEAVEEMPTY', 'JOINUNAVAIL', 'LEAVEUNAVAIL'];

export function renderQueueDialplan(snap: Snapshot): string {
  return [...snap.queues]
    .sort(byNumber)
    .map((q) => {
      const num = s.digits(q.number);
      const prefix = q.callerIdNamePrefix ? s.name(q.callerIdNamePrefix) : '';
      return [
        `; ─── Queue ${num} "${s.name(q.name)}"`,
        `[sp-queue-${s.ident(q.id)}]`,
        `exten => s,1,Set(__SP_TARGET=${num})`,
        ' same => n,Answer()',
        ...(prefix
          ? [
              ` same => n,Set(CALLERID(name)=${prefix} \${CALLERID(name)})`,
              // …and before a contact's name on ringing phones (sp-sub-dial-user, 11 §6 C4).
              ` same => n,Set(__SP_CNAM_PREFIX=${prefix} \${SP_CNAM_PREFIX})`,
            ]
          : []),
        ...(q.record ? [' same => n,Gosub(sp-sub-record,s,1)'] : []),
        ` same => n,Queue(${num},t,,,${s.digits(String(q.maxWaitSeconds))})`,
        ` same => n,GotoIf($[${FAILED.map((f) => `"\${QUEUESTATUS}" = "${f}"`).join(' | ')}]?fail)`,
        ' same => n,Hangup()',
        // Tells the stats why the caller left: the AMI events can't tell a timeout from a hang-up.
        ` same => n(fail),UserEvent(SpQueueExit,Queue: ${num},Status: \${QUEUESTATUS})`,
        ` same => n,${destApp(q.timeoutDestination, snap)}`,
        '',
      ].join('\n');
    })
    .join('\n');
}
