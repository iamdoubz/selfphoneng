// SPDX-License-Identifier: AGPL-3.0-or-later
// Typed key/value settings (spec 02 §3). Missing rows return the key's default.
import { eq, inArray } from 'drizzle-orm';
import { SettingsSchemas, type SettingKey, type SettingValue } from '@selfphoneng/shared';
import type { Db } from '../db/client.ts';
import { settings } from '../db/schema.ts';
import { randomAlnum } from '../crypto/secrets.ts';

function defaultFor<K extends SettingKey>(key: K): SettingValue<K> {
  if (key === 'general.timezone' && process.env.TZ) return process.env.TZ as SettingValue<K>;
  return SettingsSchemas[key].parse(undefined) as SettingValue<K>;
}

export async function getSetting<K extends SettingKey>(db: Db, key: K): Promise<SettingValue<K>> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key));
  if (row) return SettingsSchemas[key].parse(row.value) as SettingValue<K>;
  if (key === 'sms.webhookToken') {
    // Made on first read; on a race the first insert wins and both readers see it.
    await db
      .insert(settings)
      .values({ key, value: randomAlnum(32) })
      .onConflictDoNothing();
    return getSetting(db, key);
  }
  return defaultFor(key);
}

/** Every key at once (for GET /api/settings), defaults filled in. */
export async function getAllSettings(
  db: Db,
): Promise<{ [K in Exclude<SettingKey, 'sms.webhookToken'>]: SettingValue<K> }> {
  const keys = (Object.keys(SettingsSchemas) as SettingKey[]).filter(
    (k) => k !== 'sms.webhookToken',
  );
  const rows = await db.select().from(settings).where(inArray(settings.key, keys));
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  return Object.fromEntries(
    keys.map((k) => [k, stored.has(k) ? SettingsSchemas[k].parse(stored.get(k)) : defaultFor(k)]),
  ) as never;
}

export async function setSetting<K extends SettingKey>(
  db: Db,
  key: K,
  value: SettingValue<K>,
): Promise<void> {
  const v = SettingsSchemas[key].parse(value);
  await db
    .insert(settings)
    .values({ key, value: v })
    .onConflictDoUpdate({ target: settings.key, set: { value: v, updatedAt: new Date() } });
}
