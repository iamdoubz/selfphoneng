// SPDX-License-Identifier: AGPL-3.0-or-later
// The SIP port (Settings → Security), for routers or ISPs that keep UDP 5060 for themselves.
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe.skipIf(!hasTestDb)('SIP port setting', () => {
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

  it('refuses ports something else listens on', async () => {
    for (const [port, msg] of [
      [8080, /already used/],
      [5038, /already used/],
      [15000, /call audio range/],
      [5061, /must differ/],
    ] as const) {
      const r = await req('PATCH', '/api/settings', { 'sip.udpPort': port });
      expect(r.statusCode, String(port)).toBe(400);
      expect(r.json().error.message).toMatch(msg);
    }
  });

  it('5080 is saved, and phones are told', async () => {
    const r = await req('PATCH', '/api/settings', { 'sip.udpPort': 5080 });
    expect(r.statusCode).toBe(200);
    expect(r.json()['sip.udpPort']).toBe(5080);
    expect((await req('GET', '/api/system/status')).json().ports.sip).toBe(5080);
  });
});
