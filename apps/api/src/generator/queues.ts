// SPDX-License-Identifier: AGPL-3.0-or-later
// queues_selfphoneng.conf (03 §6.8): one section per queue, named by its number. Agents are Local
// channels through sp-queue-member; their state follows the user's hint.
import { byNumber, type Snapshot } from './load.ts';
import * as s from './sanitize.ts';

export function renderQueues(snap: Snapshot): string {
  return [...snap.queues]
    .sort(byNumber)
    .map((q) => {
      const num = s.digits(q.number);
      const n = (v: number) => s.digits(String(v));
      return [
        `; ─── Queue ${num} "${s.name(q.name)}"`,
        `[${num}]`,
        `strategy = ${q.strategy}`,
        `timeout = ${n(q.memberRingSeconds)}`,
        `retry = ${n(q.retrySeconds)}`,
        `wrapuptime = ${n(q.wrapupSeconds)}`,
        `maxlen = ${n(q.maxCallers)}`,
        `musicclass = ${s.ident(q.mohClass)}`,
        `announce-frequency = ${q.announcePosition ? n(q.announceEverySeconds) : 0}`,
        `announce-position = ${q.announcePosition ? 'yes' : 'no'}`,
        'ringinuse = no',
        'setinterfacevar = yes',
        ...(q.joinWhenNoAgents
          ? []
          : [
              'joinempty = paused,unavailable,invalid,unknown',
              'leavewhenempty = paused,unavailable,invalid,unknown',
            ]),
        ...[...q.members].sort(byNumber).map((m) => {
          const ext = s.digits(m.number);
          return `member => Local/${ext}@sp-queue-member/n,${n(m.penalty)},${s.name(m.name) || ext},hint:${ext}@sp-local-numbers`;
        }),
        '',
      ].join('\n');
    })
    .join('\n');
}
