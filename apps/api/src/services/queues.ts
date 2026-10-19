// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent pause (logged out) state: PostgreSQL queue_member_state is the truth, AstDB SP/QPAUSE lets
// *45 toggle it, and app_queue's own pause flag is what stops calls (03 §6.8, 04 §5.5).
import type { Db } from '../db/client.ts';
import { queueMemberState } from '../db/schema.ts';
import { pausedMembers, setQueuePause, type AstDbAmi } from './astdb.ts';

export const memberInterface = (ext: string) => `Local/${ext}@sp-queue-member/n`;

const queuePause = (ami: AstDbAmi, queue: string, ext: string, paused: boolean) =>
  ami.action({
    Action: 'QueuePause',
    Queue: queue,
    Interface: memberInterface(ext),
    Paused: paused ? 'true' : 'false',
  });

/** Stores the state; with AMI up, also tells Asterisk (reconnects resync everything). */
export async function setPaused(
  db: Db,
  ami: AstDbAmi & { isConnected(): boolean },
  q: { id: string; number: string },
  ext: { id: string; number: string },
  paused: boolean,
): Promise<void> {
  await db
    .insert(queueMemberState)
    .values({ queueId: q.id, extensionId: ext.id, paused })
    .onConflictDoUpdate({
      target: [queueMemberState.queueId, queueMemberState.extensionId],
      set: { paused },
    });
  if (!ami.isConnected()) return;
  await setQueuePause(ami, q.number, ext.number, paused);
  // A queue saved a moment ago may not be loaded yet; its reload re-sends the pauses.
  await queuePause(ami, q.number, ext.number, paused).catch(() => undefined);
}

/** `queue reload all` unpauses everyone (03 §1 step 9): pause the paused ones again. */
export async function resendPauses(db: Db, ami: AstDbAmi): Promise<void> {
  for (const p of await pausedMembers(db))
    await queuePause(ami, p.queue, p.ext, true).catch(() => undefined); // not loaded yet: next apply
}
