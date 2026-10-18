// SPDX-License-Identifier: AGPL-3.0-or-later
// Feature codes change AstDB from a phone, then raise UserEvent(SpToggle, Key, ...) so PostgreSQL
// follows (04 §5.3). M6-T4: TCOVR (*31N/*32N/*33N). M6-T7 adds DND and forwards.
import type { EventEmitter } from 'node:events';
import { eq } from 'drizzle-orm';
import { field, type AmiMessage } from '../ami/events.ts';
import type { Db } from '../db/client.ts';
import { timeConditions } from '../db/schema.ts';

export type ToggleDeps = {
  db: Db;
  log: { info(o: object, msg: string): void; error(o: object, msg: string): void };
};

export async function handleToggle(d: ToggleDeps, m: AmiMessage): Promise<void> {
  const key = field(m, 'Key');
  if (key === 'TCOVR') {
    const id = field(m, 'Id') ?? '';
    const value = field(m, 'Value');
    if (!/^[0-9a-f-]{36}$/.test(id) || !['open', 'closed', 'auto'].includes(value ?? '')) return;
    await d.db
      .update(timeConditions)
      .set({ overrideState: value === 'auto' ? null : value })
      .where(eq(timeConditions.id, id));
    d.log.info({ id, value }, 'office hours override from a phone');
  }
}

export function watchToggles(d: ToggleDeps, ami: Pick<EventEmitter, 'on'>) {
  ami.on('event', (m: AmiMessage) => {
    if (field(m, 'Event') !== 'UserEvent' || field(m, 'UserEvent') !== 'SpToggle') return;
    void handleToggle(d, m).catch((err: unknown) => d.log.error({ err }, 'SpToggle failed'));
  });
}
