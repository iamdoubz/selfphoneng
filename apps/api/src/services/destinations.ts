// SPDX-License-Identifier: AGPL-3.0-or-later
// Destinations live in jsonb, so there are no foreign keys: these keep them honest (02 §1).
import { eq, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { formatNumber, type Destination } from '@selfphoneng/shared';
import type { Db } from '../db/client.ts';
import {
  announcements,
  conferences,
  dids,
  extensions,
  ivrOptions,
  ivrs,
  queues,
  ringGroups,
  settings,
  timeConditions,
} from '../db/schema.ts';
import { badRequest } from '../errors.ts';

type RefType = Exclude<Destination['type'], 'external' | 'hangup'>;

const TABLES = {
  ring_group: ringGroups,
  queue: queues,
  ivr: ivrs,
  time_condition: timeConditions,
  conference: conferences,
  announcement: announcements,
} as const;

/** One row's name, or null when it doesn't exist. */
async function targetName(db: Db, type: RefType, id: string): Promise<string | null> {
  if (type === 'user' || type === 'voicemail') {
    const [e] = await db
      .select({ number: extensions.number, name: extensions.name })
      .from(extensions)
      .where(eq(extensions.id, id));
    return e ? `${e.name} (${e.number})` : null;
  }
  const t = TABLES[type];
  const [r] = await db.select({ name: t.name }).from(t).where(eq(t.id, id));
  return r?.name ?? null;
}

/** Throws 400 when a destination points at something that doesn't exist. */
export async function assertDestinationExists(db: Db, d: Destination): Promise<void> {
  if (d.type === 'hangup' || d.type === 'external') return;
  if ((await targetName(db, d.type, d.id)) === null)
    throw badRequest(`That ${d.type.replace('_', ' ')} doesn't exist any more`);
}

const LABEL: Record<RefType, string> = {
  user: 'Ring',
  voicemail: 'Voicemail of',
  ring_group: 'Ring group',
  queue: 'Queue',
  ivr: 'Digital receptionist',
  time_condition: 'Office hours',
  conference: 'Conference',
  announcement: 'Announcement',
};

/** "Ring Dan Doe (101)", "Call (312) 555-1234", "Hang up". */
export async function describeDestination(db: Db, d: Destination): Promise<string> {
  if (d.type === 'hangup') return 'Hang up';
  if (d.type === 'external') return `Call ${formatNumber(d.number)}`;
  return `${LABEL[d.type]} ${(await targetName(db, d.type, d.id)) ?? '(missing)'}`;
}

/**
 * Every place a destination points at (type, id). Keep in sync with the column list in 02 §1.
 * `user` and `voicemail` both point at an extension, so asking for either finds both.
 */
export async function findReferences(db: Db, type: RefType, id: string): Promise<string[]> {
  const types = type === 'user' || type === 'voicemail' ? ['user', 'voicemail'] : [type];
  const matches = (col: AnyPgColumn): SQL =>
    sql.join(
      types.map((t) => sql`${col} @> ${JSON.stringify({ type: t, id })}::jsonb`),
      sql` or `,
    );
  const or = (...cols: AnyPgColumn[]) => sql.join(cols.map(matches), sql` or `);
  const named = (what: string) => (rows: { n: string }[]) => rows.map((r) => `${what} ${r.n}`);
  const found = [
    ...(await db.select({ n: dids.number }).from(dids).where(matches(dids.destination))).map(
      (r) => `number ${formatNumber(r.n)}`,
    ),
    ...named('ring group')(
      await db
        .select({ n: ringGroups.name })
        .from(ringGroups)
        .where(matches(ringGroups.noAnswerDestination)),
    ),
    ...named('queue')(
      await db.select({ n: queues.name }).from(queues).where(matches(queues.timeoutDestination)),
    ),
    ...named('digital receptionist')(
      await db
        .select({ n: ivrs.name })
        .from(ivrs)
        .where(or(ivrs.timeoutDestination, ivrs.invalidDestination)),
    ),
    ...named('digital receptionist')(
      await db
        .select({ n: ivrs.name })
        .from(ivrOptions)
        .innerJoin(ivrs, eq(ivrs.id, ivrOptions.ivrId))
        .where(matches(ivrOptions.destination)),
    ),
    ...named('office hours')(
      await db
        .select({ n: timeConditions.name })
        .from(timeConditions)
        .where(
          or(
            timeConditions.openDestination,
            timeConditions.closedDestination,
            timeConditions.holidayDestination,
          ),
        ),
    ),
    ...named('announcement')(
      await db
        .select({ n: announcements.name })
        .from(announcements)
        .where(matches(announcements.destination)),
    ),
    ...(
      await db
        .select({ n: settings.key })
        .from(settings)
        .where(
          sql`${settings.key} = 'routing.unmatchedDidDestination' and (${matches(settings.value)})`,
        )
    ).map(() => 'the setting for calls to unknown numbers'),
  ];
  return [...new Set(found)];
}
