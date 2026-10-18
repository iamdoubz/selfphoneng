// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.ts';
import { getAllSettings, getSetting, setSetting } from '../src/services/settings.ts';
import { createTestDb, hasTestDb } from './db.ts';

describe.skipIf(!hasTestDb)('settings service', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ db, drop } = await createTestDb()));
  afterAll(() => drop?.());

  it('returns defaults for missing rows', async () => {
    expect(await getSetting(db, 'general.companyName')).toBe('My Company');
    expect(await getSetting(db, 'numbering.users')).toEqual([100, 499]);
    expect(await getSetting(db, 'routing.unmatchedDidDestination')).toEqual({ type: 'hangup' });
  });

  it('stores validated values and rejects bad ones', async () => {
    await setSetting(db, 'general.companyName', 'Acme');
    await setSetting(db, 'general.companyName', 'Acme Inc');
    expect(await getSetting(db, 'general.companyName')).toBe('Acme Inc');
    await expect(setSetting(db, 'network.localNets', ['not-a-cidr'])).rejects.toThrow();
    await expect(setSetting(db, 'backup.time', '25:00')).rejects.toThrow();
  });

  it('a nullable setting can be set and cleared again (JSON null, not SQL NULL)', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    await setSetting(db, 'emergency.defaultCallerIdDidId', id);
    expect(await getSetting(db, 'emergency.defaultCallerIdDidId')).toBe(id);
    await setSetting(db, 'emergency.defaultCallerIdDidId', null);
    expect(await getSetting(db, 'emergency.defaultCallerIdDidId')).toBeNull();
  });

  it('makes sms.webhookToken once and keeps it', async () => {
    const a = await getSetting(db, 'sms.webhookToken');
    expect(a).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(await getSetting(db, 'sms.webhookToken')).toBe(a);
  });

  it('getAllSettings fills defaults and hides the webhook token', async () => {
    const all = await getAllSettings(db);
    expect(all['general.companyName']).toBe('Acme Inc');
    expect(all['sip.udpPort']).toBe(5060);
    expect('sms.webhookToken' in all).toBe(false);
  });
});
