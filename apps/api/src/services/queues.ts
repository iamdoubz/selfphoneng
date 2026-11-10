// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent pause (logged out) state: PostgreSQL queue_member_state is the truth, AstDB SP/QPAUSE lets
// *45 toggle it, and app_queue's own pause flag is what stops calls (03 §6.8, 04 §5.5). A pause
// can carry a break reason, and every one is kept in queue_pauses for the report (16 §2).
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { queueMemberState, queuePauses } from '../db/schema.ts';
import { badRequest } from '../errors.ts';
import { pausedMembers, setQueuePause, type AstDbAmi } from './astdb.ts';
import { getSetting } from './settings.ts';

export const memberInterface = (ext: string) => `Local/${ext}@sp-queue-member/n`;

const queuePause = (
  ami: AstDbAmi,
  queue: string,
  ext: string,
  paused: boolean,
  reason: string | null = null,
) =>
  ami.action({
    Action: 'QueuePause',
    Queue: queue,
    Interface: memberInterface(ext),
    Paused: paused ? 'true' : 'false',
    ...(paused && reason ? { Reason: reason } : {}),
  });

/** A reason sent with a pause: one from Settings (`queues.breakReasons`), or none. */
export async function checkReason(db: Db, reason: string | undefined): Promise<string | null> {
  if (!reason) return null;
  if (!(await getSetting(db, 'queues.breakReasons')).includes(reason))
    throw badRequest('That break reason isn’t in the list any more. Reload the page.');
  return reason;
}

/**
 * PostgreSQL's part of a pause or unpause: the state, and the break in queue_pauses. Pausing
 * while paused (a new reason) ends the open break and starts another.
 */
export async function storePause(
  db: Db,
  queueId: string,
  extensionId: string,
  paused: boolean,
  reason: string | null,
): Promise<void> {
  const r = paused ? reason : null;
  await db
    .insert(queueMemberState)
    .values({ queueId, extensionId, paused, reason: r })
    .onConflictDoUpdate({
      target: [queueMemberState.queueId, queueMemberState.extensionId],
      set: { paused, reason: r },
    });
  await db
    .update(queuePauses)
    .set({ endedAt: new Date() })
    .where(
      and(
        eq(queuePauses.queueId, queueId),
        eq(queuePauses.extensionId, extensionId),
        isNull(queuePauses.endedAt),
      ),
    );
  if (paused) await db.insert(queuePauses).values({ queueId, extensionId, reason: r });
}

/** Stores the state; with AMI up, also tells Asterisk (reconnects resync everything). */
export async function setPaused(
  db: Db,
  ami: AstDbAmi & { isConnected(): boolean },
  q: { id: string; number: string },
  ext: { id: string; number: string },
  paused: boolean,
  reason: string | null = null,
): Promise<void> {
  await storePause(db, q.id, ext.id, paused, reason);
  if (!ami.isConnected()) return;
  await setQueuePause(ami, q.number, ext.number, paused);
  // A queue saved a moment ago may not be loaded yet; its reload re-sends the pauses.
  await queuePause(ami, q.number, ext.number, paused, reason).catch(() => undefined);
}

/** `queue reload all` unpauses everyone (03 §1 step 9): pause the paused ones again. */
export async function resendPauses(db: Db, ami: AstDbAmi): Promise<void> {
  for (const p of await pausedMembers(db))
    await queuePause(ami, p.queue, p.ext, true, p.reason).catch(() => undefined); // not loaded yet: next apply
}
