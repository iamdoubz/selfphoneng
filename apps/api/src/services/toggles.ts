// SPDX-License-Identifier: AGPL-3.0-or-later
// Feature codes change AstDB from a phone, then raise UserEvent(SpToggle, Key, ...) so PostgreSQL
// follows (04 §5.3): TCOVR (*31N/*32N/*33N), DND (*78/*79), CFU (*72<number>/*73), QPAUSE (*45N).
import type { EventEmitter } from 'node:events';
import { and, eq } from 'drizzle-orm';
import type { LiveMessage } from '@selfphoneng/shared';
import { field, type AmiMessage } from '../ami/events.ts';
import type { Db } from '../db/client.ts';
import {
  extensions,
  queueMembers,
  queueMemberState,
  queues,
  timeConditions,
  userRuntimeState,
} from '../db/schema.ts';
import { HttpError } from '../errors.ts';
import { setForward, type AstDbAmi } from './astdb.ts';
import { audit } from './audit.ts';
import { checkForward } from './forwards.ts';

export type ToggleDeps = {
  db: Db;
  ami: AstDbAmi;
  live: { emit(event: 'message', m: LiveMessage): unknown; loadFromDb(): Promise<void> };
  log: { info(o: object, msg: string): void; error(o: object, msg: string): void };
};

export async function handleToggle(d: ToggleDeps, m: AmiMessage): Promise<void> {
  const key = field(m, 'Key');
  const value = field(m, 'Value') ?? '';
  if (key === 'TCOVR') {
    const id = field(m, 'Id') ?? '';
    if (!/^[0-9a-f-]{36}$/.test(id) || !['open', 'closed', 'auto'].includes(value)) return;
    await d.db
      .update(timeConditions)
      .set({ overrideState: value === 'auto' ? null : value })
      .where(eq(timeConditions.id, id));
    d.log.info({ id, value }, 'office hours override from a phone');
    return;
  }
  if (key === 'QPAUSE') {
    // The dialplan only raises it after app_queue accepted the change, so the agent exists.
    const [agent] = await d.db
      .select({ queueId: queues.id, extensionId: extensions.id })
      .from(queueMembers)
      .innerJoin(queues, eq(queues.id, queueMembers.queueId))
      .innerJoin(extensions, eq(extensions.id, queueMembers.extensionId))
      .where(
        and(
          eq(queues.number, field(m, 'Queue') ?? ''),
          eq(extensions.number, field(m, 'Ext') ?? ''),
        ),
      );
    if (!agent) return;
    await d.db
      .insert(queueMemberState)
      .values({ ...agent, paused: value === '1' })
      .onConflictDoUpdate({
        target: [queueMemberState.queueId, queueMemberState.extensionId],
        set: { paused: value === '1' },
      });
    return; // app_queue's QueueMemberPause event updates the live view
  }
  if (key !== 'DND' && key !== 'CFU') return;
  const [ext] = await d.db
    .select({ id: extensions.id, number: extensions.number, userId: extensions.userId })
    .from(extensions)
    .where(eq(extensions.number, field(m, 'Ext') ?? ''));
  if (!ext) return;

  if (key === 'DND') {
    await d.db
      .update(userRuntimeState)
      .set({ dnd: value === '1' })
      .where(eq(userRuntimeState.extensionId, ext.id));
  } else {
    let target: string | null = null;
    if (value) {
      try {
        target = await checkForward(d.db, ext, value);
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        // Not allowed: undo it in Asterisk, keep nothing, tell the user (04 §5.3).
        await setForward(d.ami, 'cfu', ext.number, null);
        await audit(d.db, {
          action: 'forward_rejected',
          entityType: 'extension',
          entityId: ext.id,
          summary: `Forward of ${ext.number} to ${value} refused: ${e.message}`,
        });
        if (ext.userId)
          d.live.emit('message', {
            type: 'toast',
            data: { userId: ext.userId, message: `Call forwarding not turned on: ${e.message}` },
          });
      }
    }
    await d.db
      .update(userRuntimeState)
      .set({ cfu: target })
      .where(eq(userRuntimeState.extensionId, ext.id));
  }
  await d.live.loadFromDb(); // DND shows on everyone's presence
}

export function watchToggles(d: ToggleDeps, ami: Pick<EventEmitter, 'on'>) {
  ami.on('event', (m: AmiMessage) => {
    if (field(m, 'Event') !== 'UserEvent' || field(m, 'UserEvent') !== 'SpToggle') return;
    void handleToggle(d, m).catch((err: unknown) => d.log.error({ err }, 'SpToggle failed'));
  });
}
