// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.ts';

const env = {
  APP_SECRET: Buffer.alloc(32, 7).toString('base64'),
  PUBLIC_HOSTNAME: 'pbx.test',
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5433/db',
  INITIAL_ADMIN_EMAIL: 'admin@example.com',
  INITIAL_ADMIN_PASSWORD: 'x',
  AMI_SECRET: 'ami-secret-123',
};

describe('config', () => {
  it('parses a minimal env with defaults', () => {
    expect(loadConfig(env)).toMatchObject({ API_PORT: 8080, TRUST_PROXY: true });
  });
  it('rejects a missing or short APP_SECRET', () => {
    expect(() => loadConfig({ ...env, APP_SECRET: undefined })).toThrow(ConfigError);
    expect(() => loadConfig({ ...env, APP_SECRET: 'c2hvcnQ=' })).toThrow(/APP_SECRET/);
  });
  it('call audio ports: 10000–20000 by default; the end above the start', () => {
    expect(loadConfig(env)).toMatchObject({ RTP_PORT_START: 10000, RTP_PORT_END: 20000 });
    expect(loadConfig({ ...env, RTP_PORT_START: '40000', RTP_PORT_END: '40199' })).toMatchObject({
      RTP_PORT_START: 40000,
      RTP_PORT_END: 40199,
    });
    expect(() => loadConfig({ ...env, RTP_PORT_START: '40000', RTP_PORT_END: '30000' })).toThrow(
      /RTP_PORT_END/,
    );
  });
  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => loadConfig({ ...env, DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
  });
});
