// SPDX-License-Identifier: AGPL-3.0-or-later
// M9-T1: the voip.ms API client and what uses it (06 §5.1, §7), against a fake voip.ms.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDids, voipmsApi, VoipmsError } from '../src/integrations/voipms/client.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

/** A fake rest.php: answers per method; remembers the queries it got. */
function fakeVoipms() {
  const seen: URLSearchParams[] = [];
  const answers: Record<string, unknown> = {
    getServersInfo: {
      status: 'success',
      servers: [
        { server_name: 'Seattle 1', server_hostname: 'seattle1.voip.ms', server_ip: '1.2.3.4' },
        { server_name: 'Chicago 1', server_hostname: 'chicago1.voip.ms', server_ip: '1.2.3.5' },
      ],
    },
    getDIDsInfo: {
      status: 'success',
      dids: [
        { did: '3125551234', description: 'Main line', sms_enabled: '1' },
        { did: '3125555678', description: '', sms_enabled: '0' },
        { did: 'junk' },
      ],
    },
  };
  const server: Server = createServer((req, res) => {
    const q = new URL(req.url!, 'http://x').searchParams;
    seen.push(q);
    const ok = q.get('api_username') === 'me@example.com' && q.get('api_password') === 'api-pw';
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify(
        ok
          ? (answers[q.get('method')!] ?? { status: 'invalid_method' })
          : { status: 'invalid_credentials' },
      ),
    );
  });
  return { server, seen, answers };
}

describe('voipmsApi', () => {
  const fake = fakeVoipms();
  let url: string;
  const creds = { username: 'me@example.com', password: 'api-pw' };
  beforeAll(async () => {
    await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}/api/v1/rest.php`;
  });
  afterAll(() => fake.server.close());

  it('sends the login and method as query parameters', async () => {
    await voipmsApi(url, creds, 'getServersInfo', { foo: 'a b' });
    const q = fake.seen.at(-1)!;
    expect(Object.fromEntries(q)).toEqual({
      api_username: 'me@example.com',
      api_password: 'api-pw',
      method: 'getServersInfo',
      foo: 'a b',
    });
  });

  it('errors carry the status and a message for people, never the password', async () => {
    const e = await voipmsApi(url, { ...creds, password: 'wrong-pw' }, 'getDIDsInfo').catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(VoipmsError);
    expect((e as VoipmsError).status).toBe('invalid_credentials');
    expect((e as VoipmsError).message).not.toContain('wrong-pw');
    const down = await voipmsApi('http://127.0.0.1:9/rest.php', creds, 'x').catch((x) => x);
    expect((down as VoipmsError).status).toBe('unreachable');
  });

  it('getDids normalizes numbers and skips what it can’t read; no_did is an empty list', async () => {
    expect(await getDids(url, creds)).toEqual([
      { number: '13125551234', description: 'Main line', smsEnabled: true },
      { number: '13125555678', description: '', smsEnabled: false },
    ]);
    fake.answers.getDIDsInfo = { status: 'no_did' };
    expect(await getDids(url, creds)).toEqual([]);
  });
});

describe.skipIf(!hasTestDb)('/api/trunks/:id voip.ms routes', () => {
  const fake = fakeVoipms();
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let req: (method: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  let trunkId: string;
  beforeAll(async () => {
    await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', r));
    const port = (fake.server.address() as AddressInfo).port;
    t = await createTestApp(undefined, {
      VOIPMS_API_URL: `http://127.0.0.1:${port}/api/v1/rest.php`,
    });
    await t.clearMustChange(ADMIN.email);
    const cookie = await t.login(ADMIN.email, ADMIN.password);
    req = (method, url, payload) =>
      t.app.inject({
        method: method as 'GET',
        url,
        payload: payload as object,
        headers: { ...H, cookie },
      });
    trunkId = (
      await req('POST', '/api/trunks', {
        name: 'voip.ms',
        serverHost: 'chicago1.voip.ms',
        username: '123456_pbx',
        password: 'pw',
      })
    ).json().id;
  });
  afterAll(async () => {
    await t?.close();
    fake.server.close();
  });

  it('needs API credentials on the trunk', async () => {
    const r = await req('GET', `/api/trunks/${trunkId}/voipms-servers`);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/API username and password/);
  });

  it('a wrong API password is a 502 with voip.ms’s reason', async () => {
    await req('PATCH', `/api/trunks/${trunkId}`, {
      voipmsApiUsername: 'me@example.com',
      voipmsApiPassword: 'nope',
    });
    const r = await req('GET', `/api/trunks/${trunkId}/voipms-servers`);
    expect(r.statusCode).toBe(502);
    expect(r.json().error.message).toBe('voip.ms rejected the API username or password');
    expect(r.body).not.toContain('nope');
  });

  it('lists servers, previews and imports numbers (not routed, label from voip.ms)', async () => {
    await req('PATCH', `/api/trunks/${trunkId}`, { voipmsApiPassword: 'api-pw' });
    expect((await req('GET', `/api/trunks/${trunkId}/voipms-servers`)).json()).toEqual({
      servers: ['chicago1.voip.ms', 'seattle1.voip.ms'],
    });
    await req('POST', '/api/dids', {
      number: '3125555678',
      trunkId,
      destination: { type: 'hangup' },
    });
    const preview = (await req('GET', `/api/trunks/${trunkId}/import-dids`)).json().items;
    expect(preview).toEqual([
      { number: '13125551234', description: 'Main line', smsEnabled: true, added: false },
      { number: '13125555678', description: '', smsEnabled: false, added: true },
    ]);
    // a number that isn't on the account is ignored
    const r = await req('POST', `/api/trunks/${trunkId}/import-dids`, {
      numbers: ['13125551234', '19995550000'],
    });
    expect(r.json()).toEqual({ added: 1 });
    const added = (await req('GET', '/api/dids')).json().items;
    expect(added.find((d: { number: string }) => d.number === '13125551234')).toMatchObject({
      label: 'Main line',
      destination: { type: 'hangup' },
    });
    const again = await req('POST', `/api/trunks/${trunkId}/import-dids`, {
      numbers: ['13125551234'],
    });
    expect(again.statusCode).toBe(400);
  });
});
