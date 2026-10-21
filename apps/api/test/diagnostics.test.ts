// SPDX-License-Identifier: AGPL-3.0-or-later
// System → Diagnostics (08 §2.6): the inside checks with the outside lookups faked, and the
// network test against a fake probe that really sends the audio-port datagrams.
import { createSocket } from 'node:dgram';
import type { DiagnosticCheck } from '@selfphoneng/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insideChecks, networkTest, type DiagDeps } from '../src/services/diagnostics.ts';
import { setSetting } from '../src/services/settings.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

const byId = (checks: DiagnosticCheck[]) => Object.fromEntries(checks.map((c) => [c.id, c]));

describe.skipIf(!hasTestDb)('diagnostics', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let deps: DiagDeps;
  beforeAll(async () => {
    t = await createTestApp();
    deps = {
      db: t.db,
      // A small range, so the busy-port scan and the samples stay quick and local.
      config: { ...t.app.config, RTP_PORT_START: 41000, RTP_PORT_END: 41020 },
      ami: t.app.ami,
      lookupPublicIp: async () => '203.0.113.10',
      resolveHost: async () => ['203.0.113.10'],
    };
  });
  afterAll(() => t?.close());

  it('flags what keeps phones off the network: no public IP, DNS elsewhere, the phone ACL', async () => {
    let c = byId(await insideChecks({ ...deps, resolveHost: async () => ['198.51.100.7'] }));
    expect(c['public-ip']).toMatchObject({ status: 'fail' });
    expect(c['public-ip']!.fix).toContain('203.0.113.10');
    expect(c.dns).toMatchObject({ status: 'fail' });
    expect(c.dns!.fix).toContain('DNS only');
    expect(c['phone-acl']).toMatchObject({ status: 'ok' });
    expect(c.probe).toMatchObject({ status: 'skip' });
    expect(c.rtp).toMatchObject({
      status: 'ok',
      detail: expect.stringContaining('UDP 41000–41020'),
    });

    await setSetting(t.db, 'network.publicIp', '203.0.113.10');
    await setSetting(t.db, 'sip.restrictPhonesToLocalNets', true);
    await setSetting(t.db, 'network.lanIp', '10.9.0.5');
    await setSetting(t.db, 'network.localNets', ['192.168.0.0/16']);
    c = byId(await insideChecks(deps));
    expect(c['public-ip']).toMatchObject({ status: 'ok', detail: '203.0.113.10' });
    expect(c.dns).toMatchObject({ status: 'ok' });
    expect(c['phone-acl']).toMatchObject({ status: 'warn' });
    expect(c['phone-acl']!.detail).toContain('mobile data');
    expect(c['local-nets']).toMatchObject({ status: 'fail' });
    expect(c['local-nets']!.fix).toContain('10.9.0.0/24');
    await setSetting(t.db, 'sip.restrictPhonesToLocalNets', false);
  });

  it('a busy audio range is a warning that says how to move it', async () => {
    const held = await Promise.all(
      [41000, 41002, 41004, 41006].map(
        (p) =>
          new Promise<ReturnType<typeof createSocket>>((r) => {
            const s = createSocket('udp4');
            s.bind(p, () => r(s));
          }),
      ),
    );
    const c = byId(await insideChecks(deps));
    expect(c.rtp).toMatchObject({ status: 'warn' });
    expect(c.rtp!.fix).toContain('RTP_PORT_START');
    held.forEach((s) => s.close());
  });

  it('network test: maps the probe’s answers to fixes; audio ports must really get through', async () => {
    await setSetting(t.db, 'network.probeUrl', 'https://probe.test');
    let seen:
      | { host: string; tests: { id: string; kind: string; port: number; token?: string }[] }
      | undefined;
    const fetchProbe = (async (_url: URL, init: RequestInit) => {
      seen = JSON.parse(String(init.body));
      // The firewall lets the first sampled audio port through and drops the rest.
      const udp = seen!.tests.filter((x) => x.kind === 'udp');
      const s = createSocket('udp4');
      await new Promise<void>((r) =>
        s.send(`selfphoneng-probe ${udp[0]!.token}`, udp[0]!.port, '127.0.0.1', () => r()),
      );
      s.close();
      const ok = (id: string, detail: string) => ({ id, ok: true, detail });
      const no = (id: string) => ({ id, ok: false, detail: 'no answer' });
      return new Response(
        JSON.stringify({
          ip: '203.0.113.10',
          results: [
            no('http'),
            ok('https', 'HTTP 200'),
            no('sip-udp'),
            ok('sip-tcp', 'SIP/2.0 401 Unauthorized'),
            { id: 'ws', ok: false, detail: 'HTTP 404' },
            ...udp.map((x) => ok(x.id, 'sent')),
          ],
        }),
      );
    }) as unknown as typeof fetch;
    const r = await networkTest({ ...deps, fetchProbe }, 'complete');
    expect(seen!.host).toBe(t.app.config.PUBLIC_HOSTNAME);
    expect(seen!.tests.map((x) => x.id)).toEqual(
      expect.arrayContaining(['http', 'https', 'sip-udp', 'sip-tcp', 'ws']),
    );
    const c = byId(r.checks);
    expect(r.testedIp).toBe('203.0.113.10');
    expect(c['probe-ip']).toMatchObject({ status: 'ok' });
    expect(c.http).toMatchObject({ status: 'warn' });
    expect(c.https).toMatchObject({ status: 'ok' });
    expect(c['sip-udp']).toMatchObject({ status: 'fail' });
    expect(c['sip-udp']!.fix).toContain('SIP ALG');
    expect(c['sip-tcp']).toMatchObject({ status: 'ok' });
    expect(c.ws).toMatchObject({ status: 'fail' });
    expect(c.rtp).toMatchObject({ status: 'warn' });
    expect(c.rtp!.fix).toContain('ufw allow 41000:41020/udp');

    // Quick: no audio ports, no /ws.
    const quick = await networkTest(
      {
        ...deps,
        fetchProbe: (async (_u: URL, init: RequestInit) => {
          seen = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ ip: '192.168.1.9', results: [] }));
        }) as unknown as typeof fetch,
      },
      'quick',
    );
    expect(seen!.tests.map((x) => x.kind)).not.toContain('udp');
    expect(byId(quick.checks)['probe-ip']).toMatchObject({ status: 'warn' }); // a private address
  });

  it('routes: admins only; no probe set is a 400', async () => {
    await t.clearMustChange(ADMIN.email);
    const cookie = await t.login(ADMIN.email, ADMIN.password);
    const r = await t.app.inject({
      method: 'GET',
      url: '/api/system/diagnostics',
      headers: { ...H, cookie },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().checks.length).toBeGreaterThan(3);
    await setSetting(t.db, 'network.probeUrl', null);
    const n = await t.app.inject({
      method: 'POST',
      url: '/api/system/diagnostics/network',
      headers: { ...H, cookie },
      payload: { mode: 'quick' },
    });
    expect(n.statusCode).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/api/system/diagnostics' })).statusCode).toBe(
      401,
    );
  });
});
