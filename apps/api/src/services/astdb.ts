// SPDX-License-Identifier: AGPL-3.0-or-later
// AstDB holds what the dialplan reads at call time (overrides, DND, forwards, blocks). PostgreSQL
// is the truth: routes write it first, then call one of these; every AMI connect resyncs (04 §5.5).
import { eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { extensions, timeConditions, userRuntimeState } from '../db/schema.ts';

export type AstDbAmi = { action(fields: Record<string, string>): Promise<unknown> };

const put = (ami: AstDbAmi, key: string, val: string) =>
  ami.action({ Action: 'DBPut', Family: 'SP', Key: key, Val: val });
/** Deleting a key that isn't there is an AMI error; that's fine. */
const del = (ami: AstDbAmi, key: string) =>
  ami.action({ Action: 'DBDel', Family: 'SP', Key: key }).catch(() => undefined);

export const setTcOverride = (ami: AstDbAmi, id: string, state: 'open' | 'closed' | null) =>
  state ? put(ami, `TCOVR/${id}`, state) : del(ami, `TCOVR/${id}`);

export const setDnd = (ami: AstDbAmi, ext: string, on: boolean) =>
  on ? put(ami, `DND/${ext}`, '1') : del(ami, `DND/${ext}`);

/** kind: cfu (always), cfb (busy), cfna (no answer); null turns it off. */
export const setForward = (
  ami: AstDbAmi,
  kind: 'cfu' | 'cfb' | 'cfna',
  ext: string,
  target: string | null,
) =>
  target
    ? put(ami, `${kind.toUpperCase()}/${ext}`, target)
    : del(ami, `${kind.toUpperCase()}/${ext}`);

/** Wipe our keys and write them again from PostgreSQL. M6-T8 adds blocks, M8 queue pauses. */
export async function syncAstDb(db: Db, ami: AstDbAmi): Promise<void> {
  await ami.action({ Action: 'DBDelTree', Family: 'SP' }).catch(() => undefined); // empty tree
  const overrides = await db
    .select({ id: timeConditions.id, state: timeConditions.overrideState })
    .from(timeConditions)
    .where(isNotNull(timeConditions.overrideState));
  for (const o of overrides) await setTcOverride(ami, o.id, o.state as 'open' | 'closed');
  const runtime = await db
    .select({ ext: extensions.number, s: userRuntimeState })
    .from(userRuntimeState)
    .innerJoin(extensions, eq(extensions.id, userRuntimeState.extensionId));
  for (const { ext, s } of runtime) {
    if (s.dnd) await setDnd(ami, ext, true);
    for (const kind of ['cfu', 'cfb', 'cfna'] as const)
      if (s[kind]) await setForward(ami, kind, ext, s[kind]);
  }
}
