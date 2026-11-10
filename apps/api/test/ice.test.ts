// SPDX-License-Identifier: AGPL-3.0-or-later
// 04 §12: STUN and TURN for the browser softphone: the setting, both sign-in kinds, env defaults.
import { createHmac } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { settings } from '../src/db/schema.ts';
import { timedTurnCredential } from '../src/services/ice.ts';
import { getSetting } from '../src/services/settings.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe('timed TURN credential', () => {
  it('is what coturn’s use-auth-secret checks: expiry:user, HMAC-SHA1 in base64', () => {
    const c = timedTurnCredential('north', '101', 3600, 1_700_000_000_000);
    expect(c.username).toBe('1700003600:101');
    expect(c.credential).toBe(
      createHmac('sha1', 'north').update('1700003600:101').digest('base64'),
    );
  });
});

describe.skipIf(!hasTestDb)('STUN and TURN settings', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  type Req = (method: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  let admin: Req;
  let dan: Req;
  const patch = (turn: unknown) => admin('PATCH', '/api/settings', { 'network.turn': turn });
  const ice = async () => (await dan('GET', '/api/me/webrtc')).json();

  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    const as =
      (cookie: string): Req =>
      (method, url, payload) =>
        t.app.inject({
          method: method as 'GET',
          url,
          payload: payload as object,
          headers: { ...H, cookie },
        });
    admin = as(await t.login(ADMIN.email, ADMIN.password));
    const u = await t.addUser('dan@example.com', 'dan-password-123');
    dan = as(await t.login('dan@example.com', 'dan-password-123'));
    await admin('POST', '/api/extensions', { number: '101', name: 'Dan Doe', userId: u.id });
  });
  afterAll(() => t?.close());

  it('nothing set: no ICE servers, nothing to refresh', async () => {
    expect(await ice()).toMatchObject({ iceServers: [], iceRefreshSeconds: null });
  });

  it('a username and password: sent as they are; the password is never read back', async () => {
    const urls = ['turn:turn.example.com:3478', 'turns:turn.example.com:5349?transport=tcp'];
    expect((await patch({ urls, auth: 'password', username: 'pbx' })).statusCode).toBe(400); // no password
    expect((await patch({ urls, auth: 'password', credential: 'x' })).statusCode).toBe(400); // no username
    expect(
      (await patch({ urls: ['http://turn.example.com'], auth: 'secret', credential: 'k' }))
        .statusCode,
    ).toBe(400);
    const r = await patch({ urls, auth: 'password', username: 'pbx', credential: 'turn-pass' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()['network.turn']).toEqual({
      urls,
      auth: 'password',
      username: 'pbx',
      ttlSeconds: 86_400,
      hasCredential: true,
    });
    expect(r.body).not.toContain('turn-pass');
    expect((await getSetting(t.db, 'network.turn'))!.credentialEnc).not.toContain('turn-pass');
    await admin('PATCH', '/api/settings', { 'network.stunServer': 'stun.example.com:3478' });
    expect(await ice()).toMatchObject({
      iceServers: [
        { urls: 'stun:stun.example.com:3478' },
        { urls, username: 'pbx', credential: 'turn-pass' },
      ],
      iceRefreshSeconds: null,
    });
    // Saved again without the password: kept.
    expect((await patch({ urls: [urls[0]], auth: 'password', username: 'pbx' })).statusCode).toBe(
      200,
    );
    expect((await ice()).iceServers[1].credential).toBe('turn-pass');
  });

  it('a time-limited key: each person gets their own credential, and when to renew it', async () => {
    const urls = ['turn:turn.example.com:3478'];
    // The old password isn't taken for the key.
    expect((await patch({ urls, auth: 'secret' })).statusCode).toBe(400);
    const r = await patch({ urls, auth: 'secret', credential: 'shared-key', ttlSeconds: 3600 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()['network.turn']).toMatchObject({ auth: 'secret', username: '' });
    const got = await ice();
    expect(got.iceRefreshSeconds).toBe(1800);
    const { username, credential } = got.iceServers[1];
    const [ends, who] = username.split(':');
    expect(who).toBe('101');
    expect(Number(ends) - Math.floor(Date.now() / 1000)).toBeGreaterThan(3590);
    expect(Number(ends) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(3600);
    expect(credential).toBe(createHmac('sha1', 'shared-key').update(username).digest('base64'));
    expect(JSON.stringify(got)).not.toContain('shared-key');
    expect((await patch({ urls, auth: 'secret', ttlSeconds: 60 })).statusCode).toBe(400);
  });

  it('reads a setting saved in the old shape', async () => {
    const enc = (await getSetting(t.db, 'network.turn'))!.credentialEnc;
    await t.db
      .update(settings)
      .set({ value: { url: 'turn:old.example.com', username: 'u', credentialEnc: enc } })
      .where(eq(settings.key, 'network.turn'));
    expect(await getSetting(t.db, 'network.turn')).toMatchObject({
      urls: ['turn:old.example.com'],
      auth: 'password',
      username: 'u',
      ttlSeconds: 86_400,
    });
  });

  it('TURN_* and STUN_SERVER start an install, until Settings is saved', async () => {
    await admin('PATCH', '/api/settings', { 'network.turn': null, 'network.stunServer': null });
    await t.db.delete(settings).where(eq(settings.key, 'network.turn'));
    await t.db.delete(settings).where(eq(settings.key, 'network.stunServer'));
    Object.assign(process.env, {
      STUN_SERVER: 'stun.env.example:3478',
      TURN_URLS: 'turn:a.example.com, turns:b.example.com:5349',
      TURN_SECRET: 'env-key',
    });
    try {
      const got = await ice();
      expect(got.iceServers[0]).toEqual({ urls: 'stun:stun.env.example:3478' });
      expect(got.iceServers[1].urls).toEqual(['turn:a.example.com', 'turns:b.example.com:5349']);
      expect(got.iceServers[1].credential).toBe(
        createHmac('sha1', 'env-key').update(got.iceServers[1].username).digest('base64'),
      );
      // Saved (here: turned off) in Settings: that wins.
      await admin('PATCH', '/api/settings', { 'network.turn': null });
      expect((await ice()).iceServers).toHaveLength(1);
    } finally {
      delete process.env.STUN_SERVER;
      delete process.env.TURN_URLS;
      delete process.env.TURN_SECRET;
    }
  });
});
