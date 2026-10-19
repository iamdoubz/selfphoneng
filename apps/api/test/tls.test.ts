// SPDX-License-Identifier: AGPL-3.0-or-later
// M11-T2: the SIP TLS certificate check, turning TLS on, and the expiry warning.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readTlsCert } from '../src/services/tls.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
const work = mkdtempSync(join(tmpdir(), 'sp-tls-certs-'));
/** A self-signed cert + key named <name>.crt/.key, valid for `days`. */
function makeCert(name: string, days: number) {
  const r = spawnSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', String(days)]
      .concat([
        '-subj',
        `/CN=${name}.example.com`,
        '-addext',
        `subjectAltName=DNS:${name}.example.com`,
      ])
      .concat(['-keyout', join(work, `${name}.key`), '-out', join(work, `${name}.crt`)]),
    { env: { ...process.env, MSYS_NO_PATHCONV: '1' } }, // Git Bash's openssl mangles /CN=
  );
  if (r.status !== 0) throw new Error(String(r.stderr));
}
/** Puts <cert>'s certificate and <key>'s key where the api (and Asterisk) look. */
function install(dir: string, cert: string, key = cert) {
  copyFileSync(join(work, `${cert}.crt`), join(dir, 'fullchain.pem'));
  copyFileSync(join(work, `${key}.key`), join(dir, 'privkey.pem'));
}

describe.skipIf(!hasOpenssl)('readTlsCert', () => {
  beforeAll(() => {
    makeCert('pbx', 365);
    makeCert('other', 365);
  });

  it('missing files, a key that does not match, a good pair', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-tls-'));
    expect(await readTlsCert(dir)).toMatchObject({ ok: false, error: /No certificate/ });
    install(dir, 'pbx', 'other');
    expect(await readTlsCert(dir)).toMatchObject({ ok: false, error: /doesn't belong/ });
    install(dir, 'pbx');
    const c = await readTlsCert(dir);
    expect(c).toMatchObject({
      ok: true,
      subject: 'CN=pbx.example.com',
      names: ['DNS:pbx.example.com'],
    });
    if (c.ok) expect(Date.parse(c.notAfter) - Date.now()).toBeGreaterThan(300 * 86_400_000);
    rmSync(dir, { recursive: true });
  });
});

describe.skipIf(!hasTestDb || !hasOpenssl)('SIP TLS setting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-tls-'));
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let req: (method: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  const warningCodes = async () =>
    (await req('GET', '/api/system/warnings')).json().items.map((w: { code: string }) => w.code);

  beforeAll(async () => {
    makeCert('soon', 5);
    makeCert('pbx', 365);
    t = await createTestApp(undefined, { TLS_DIR: dir });
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
  afterAll(async () => {
    await t?.close();
    rmSync(dir, { recursive: true });
    rmSync(work, { recursive: true, force: true });
  });

  it("won't turn on without a certificate", async () => {
    const r = await req('PATCH', '/api/settings', { 'sip.tlsEnabled': true });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/Can't turn on TLS. No certificate/);
    expect((await req('GET', '/api/system/tls')).json()).toMatchObject({ ok: false });
  });

  it('turns on with one, warns when it expires within 14 days', async () => {
    install(dir, 'soon');
    const r = await req('PATCH', '/api/settings', { 'sip.tlsEnabled': true });
    expect(r.statusCode).toBe(200);
    expect(r.json()['sip.tlsEnabled']).toBe(true);
    expect((await req('GET', '/api/system/tls')).json()).toMatchObject({
      ok: true,
      subject: 'CN=soon.example.com',
    });
    expect(await warningCodes()).toContain('tls_cert');
    install(dir, 'pbx'); // renewed
    expect(await warningCodes()).not.toContain('tls_cert');
  });

  it('a TLS trunk: no qualify, Test does not send OPTIONS, TLS stays on while it exists', async () => {
    const trunk = await req('POST', '/api/trunks', {
      name: 'voip.ms TLS',
      serverHost: '127.0.0.1',
      serverPort: 5061,
      transport: 'tls',
      srtp: true,
      username: '123456_pbx',
      password: 'pw',
    });
    expect(trunk.statusCode).toBe(201);
    await t.app.generator.apply({ trigger: 'test' });
    const { readFile } = await import('node:fs/promises');
    const conf = await readFile(join(t.app.generator.dir, 'pjsip_selfphoneng.conf'), 'utf8');
    expect(conf).toMatch(/contact = sip:127\.0\.0\.1:5061;transport=tls\nqualify_frequency = 0\n/);
    expect(conf).toMatch(/media_encryption = sdes/);
    expect(conf).toMatch(/verify_server = yes/);
    t.live.amiConnected = true;
    const test = await req('POST', `/api/trunks/${trunk.json().id}/test`);
    expect(test.statusCode).toBe(200);
    expect(t.ami.actions.filter((a) => a.Action === 'PJSIPQualify')).toEqual([]);
    const off = await req('PATCH', '/api/settings', { 'sip.tlsEnabled': false });
    expect(off.statusCode).toBe(400);
    expect(off.json().error.message).toMatch(/uses TLS/);
  });
});
