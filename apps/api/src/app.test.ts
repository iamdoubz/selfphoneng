// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';

const env = { APP_SECRET: Buffer.alloc(32, 7).toString('base64'), PUBLIC_HOSTNAME: 'pbx.test' };

describe('config', () => {
  it('parses a minimal env with defaults', () => {
    expect(loadConfig(env)).toMatchObject({ API_PORT: 8080, TRUST_PROXY: true });
  });
  it('rejects a missing or short APP_SECRET', () => {
    expect(() => loadConfig({ PUBLIC_HOSTNAME: 'x' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...env, APP_SECRET: 'c2hvcnQ=' })).toThrow(/APP_SECRET/);
  });
});

describe('app', () => {
  const pub = mkdtempSync(join(tmpdir(), 'sp-public-'));
  writeFileSync(join(pub, 'index.html'), '<h1>spa</h1>');
  const app = buildApp({ ...loadConfig(env), LOG_LEVEL: 'fatal' }, pub);

  it('GET /healthz', async () => {
    const r = await app.inject('/healthz');
    expect(r.json()).toEqual({ ok: true });
  });
  it('falls back to index.html for SPA routes only', async () => {
    expect((await app.inject('/admin/users')).body).toBe('<h1>spa</h1>');
    expect((await app.inject('/api/nope')).statusCode).toBe(404);
    expect((await app.inject('/prov/x.cfg')).statusCode).toBe(404);
  });
});
