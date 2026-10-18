// SPDX-License-Identifier: AGPL-3.0-or-later
// M3-T5: what the setup wizard needs from the api: status/complete, public IP detection,
// system status, and the telephony restart that clears "restart required".
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { settings } from '../src/db/schema.ts';
import { AmiDisconnectedError } from '../src/ami/client.ts';
import { clearRestartIfRestarted } from '../src/generator/index.ts';
import { getSetting, setSetting } from '../src/services/settings.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe.skipIf(!hasTestDb)('setup wizard api', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let req: (method: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;

  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    const cookie = await t.login(ADMIN.email, ADMIN.password);
    req = (method, url, payload) =>
      t.app.inject({
        method: method as 'GET',
        url,
        payload: payload as object,
        headers: { ...H, cookie },
      });
  });
  afterAll(() => t?.close());

  it('setup starts incomplete and can be completed (and is read-only in PATCH)', async () => {
    expect((await req('GET', '/api/setup/status')).json()).toEqual({ completed: false });
    expect((await req('PATCH', '/api/settings', { 'setup.completed': true })).statusCode).toBe(400);
    expect((await req('POST', '/api/setup/complete')).statusCode).toBe(200);
    expect((await req('GET', '/api/setup/status')).json()).toEqual({ completed: true });
  });

  it('detects the public IP, falling back to the second service', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('<html>blocked</html>'))
      .mockResolvedValueOnce(new Response('203.0.113.7\n'));
    const r = await req('POST', '/api/settings/network/detect-public-ip');
    expect(r.json()).toEqual({ ip: '203.0.113.7' });
    spy.mockRejectedValue(new Error('offline'));
    expect((await req('POST', '/api/settings/network/detect-public-ip')).statusCode).toBe(502);
    spy.mockRestore();
  });

  it('system status lists LAN addresses; restart goes through AMI', async () => {
    const s = (await req('GET', '/api/system/status')).json();
    expect(s).toMatchObject({ ami: { connected: true }, restartRequired: false });
    expect(Array.isArray(s.lanIps)).toBe(true);
    expect((await req('POST', '/api/system/asterisk/restart?now=true')).statusCode).toBe(200);
    expect(t.ami.actions.at(-1)).toEqual({ Action: 'Command', Command: 'core restart now' });
    await req('POST', '/api/system/asterisk/restart');
    expect(t.ami.actions.at(-1)).toEqual({ Action: 'Command', Command: 'core restart gracefully' });
    // A real restart closes AMI before it replies: still a success.
    const action = t.ami.action;
    t.ami.action = async () => {
      throw new AmiDisconnectedError();
    };
    expect((await req('POST', '/api/system/asterisk/restart?now=true')).statusCode).toBe(200);
    t.ami.action = action;
  });

  it('"restart required" clears only when Asterisk started after the change', async () => {
    await setSetting(t.db, 'system.restartRequired', true);
    const [row] = await t.db
      .select({ at: settings.updatedAt })
      .from(settings)
      .where(eq(settings.key, 'system.restartRequired'));
    const changedAt = row!.at.getTime();
    const ami = (uptime: number) => ({
      command: async () => `System uptime: ${uptime}\nLast reload: ${uptime}\n`,
    });
    // Up for an hour: started before the change, still running the old transports.
    expect(await clearRestartIfRestarted(t.db, ami(3600), changedAt + 5000)).toBe(false);
    expect(await getSetting(t.db, 'system.restartRequired')).toBe(true);
    // Up for 2 s, 5 s after the change: it restarted since.
    expect(await clearRestartIfRestarted(t.db, ami(2), changedAt + 5000)).toBe(true);
    expect(await getSetting(t.db, 'system.restartRequired')).toBe(false);
  });
});
