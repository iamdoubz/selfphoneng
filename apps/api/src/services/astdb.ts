// SPDX-License-Identifier: AGPL-3.0-or-later
// AstDB holds what the dialplan reads at call time (overrides, DND, forwards, blocks). PostgreSQL
// is the truth: routes write it first, then call one of these; every AMI connect resyncs (04 §5.5).
import { isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { timeConditions } from '../db/schema.ts';

export type AstDbAmi = { action(fields: Record<string, string>): Promise<unknown> };

const put = (ami: AstDbAmi, key: string, val: string) =>
  ami.action({ Action: 'DBPut', Family: 'SP', Key: key, Val: val });
/** Deleting a key that isn't there is an AMI error; that's fine. */
const del = (ami: AstDbAmi, key: string) =>
  ami.action({ Action: 'DBDel', Family: 'SP', Key: key }).catch(() => undefined);

export const setTcOverride = (ami: AstDbAmi, id: string, state: 'open' | 'closed' | null) =>
  state ? put(ami, `TCOVR/${id}`, state) : del(ami, `TCOVR/${id}`);

/** Wipe our keys and write them again from PostgreSQL. M6-T7/T8 add DND, forwards, blocks. */
export async function syncAstDb(db: Db, ami: AstDbAmi): Promise<void> {
  await ami.action({ Action: 'DBDelTree', Family: 'SP' }).catch(() => undefined); // empty tree
  const overrides = await db
    .select({ id: timeConditions.id, state: timeConditions.overrideState })
    .from(timeConditions)
    .where(isNotNull(timeConditions.overrideState));
  for (const o of overrides) await setTcOverride(ami, o.id, o.state as 'open' | 'closed');
}
