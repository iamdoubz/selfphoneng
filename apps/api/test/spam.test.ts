// SPDX-License-Identifier: AGPL-3.0-or-later
// SD1, SD2: the spam check (14): IPQualityScore first, then the local FTC copy, against a fake fetch.
import { eq, like, sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPAM_DEFAULTS, type SpamSettings } from '@selfphoneng/shared';
import { encrypt } from '../src/crypto/secrets.ts';
import {
  auditLog,
  ftcComplaints,
  settings as settingsTable,
  spamLookups,
  systemEvents,
} from '../src/db/schema.ts';
import { checkNumber, spamQuotaCheck } from '../src/spam/check.ts';
import { getSetting, setSetting } from '../src/services/settings.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

const IPQS_KEY = 'ipqs-secret-key-123';
const FTC_KEY = 'datagov-secret-key-456';
const SPAMMER = '13125550001';
const SHADY = '13125550002';
const CLEAN = '13125550003';
const REPORTED = '13125550004';

/** IPQualityScore's phone answers by number; anything else is a valid, clean line. */
const ANSWERS: Record<string, Record<string, unknown>> = {
  [SPAMMER]: { fraud_score: 40, spammer: true, line_type: 'VOIP', carrier: 'Acme Tel' },
  [SHADY]: { fraud_score: 78, city: 'Austin', region: 'TX', name: 'N/A' },
  [CLEAN]: { fraud_score: 10, line_type: 'Wireless', carrier: 'Verizon' },
};

describe.skipIf(!hasTestDb)('spam check', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  type Req = (method: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  let admin: Req;
  const urls: string[] = [];
  /** What the fake IPQualityScore does: answer, fail, or say the credits are used up. */
  let ipqs: 'ok' | 'down' | 'exhausted' | 'slow' = 'ok';
  let credits = 912;
  const log = { warn: vi.fn() };
  const d = () => ({ db: t.db, log });

  const settings = (s: Partial<SpamSettings>) =>
    setSetting(t.db, 'spam', { ...SPAM_DEFAULTS, enabled: true, ...s });
  // Getters: the secret key is only set once createTestApp has run.
  const keys = {
    get withIpqs() {
      return { ipqs: { keyEnc: encrypt(IPQS_KEY) } };
    },
    get withFtc() {
      return { ftc: { keyEnc: encrypt(FTC_KEY), syncHours: 24, windowDays: 30 } };
    },
  };

  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    const cookie = await t.login(ADMIN.email, ADMIN.password);
    admin = (method, url, payload) =>
      t.app.inject({
        method: method as 'GET',
        url,
        payload: payload as object,
        headers: { ...H, cookie },
      });
    const day = (n: number) => sql`now() - make_interval(days => ${n})`;
    await t.db.insert(ftcComplaints).values([
      { id: 'a1', number: REPORTED, reportedAt: day(1), subject: 'Warranties', robocall: true },
      { id: 'a2', number: REPORTED, reportedAt: day(2), subject: 'Warranties', robocall: true },
      { id: 'a3', number: REPORTED, reportedAt: day(3), subject: 'Debt', robocall: false },
      { id: 'a4', number: REPORTED, reportedAt: day(40), subject: 'Debt', robocall: true },
      { id: 'b1', number: SHADY, reportedAt: day(5), subject: null, robocall: null },
    ]);
  });
  afterAll(() => t?.close());

  beforeEach(() => {
    urls.length = 0;
    log.warn.mockClear();
    ipqs = 'ok';
    credits = 912;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      urls.push(url);
      const json = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status });
      if (url.startsWith('https://api.ftc.gov/')) {
        const key = (init?.headers as Record<string, string>)['X-Api-Key'];
        return key === FTC_KEY ? json({ data: [] }) : json({ error: {} }, 403);
      }
      const account = /\/api\/json\/account\/([^/]+)$/.exec(url);
      if (account)
        return account[1] === IPQS_KEY
          ? json({ success: true, credits, usage: 88 })
          : json({ success: false, message: `Invalid or unauthorized key: ${account[1]}` });
      const phone = /\/api\/json\/phone\/[^/]+\/(\d+)\?country\[\]=US$/.exec(url);
      if (!phone) return json({}, 404);
      if (ipqs === 'down') return json({}, 503);
      if (ipqs === 'slow') throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
      if (ipqs === 'exhausted')
        return json({
          success: false,
          message: 'You have insufficient credits to make this query.',
        });
      await new Promise((r) => setTimeout(r, 20));
      return json({ success: true, valid: true, ...(ANSWERS[phone[1]!] ?? { fraud_score: 0 }) });
    });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.db.delete(spamLookups);
    await t.db.delete(settingsTable).where(eq(settingsTable.key, 'spam.state'));
    await t.db.delete(systemEvents).where(like(systemEvents.code, 'spam.%'));
  });

  it('checks nothing while off, and only US numbers', async () => {
    await setSetting(t.db, 'spam', { ...SPAM_DEFAULTS, ...keys.withIpqs });
    expect(await checkNumber(d(), SPAMMER)).toBeNull();
    await settings(keys.withIpqs);
    for (const n of ['442079460958', '911', '101', '13125550', '10005550001'])
      expect(await checkNumber(d(), n)).toBeNull();
    expect(urls).toEqual([]);
  });

  it('IPQualityScore: risk from its flags and score, only the kept fields', async () => {
    await settings(keys.withIpqs);
    expect(await checkNumber(d(), SPAMMER)).toEqual({
      risk: 'high',
      provider: 'ipqs',
      info: {
        fraudScore: 40,
        spammer: true,
        recentAbuse: false,
        lineType: 'VOIP',
        carrier: 'Acme Tel',
        name: null,
        city: null,
        region: null,
      },
    });
    expect((await checkNumber(d(), SHADY))?.risk).toBe('medium');
    expect(await checkNumber(d(), CLEAN)).toMatchObject({
      risk: 'low',
      info: { carrier: 'Verizon' },
    });
    expect(urls).toHaveLength(3);
  });

  it('caches answers: flagged for flaggedDays, the rest for cleanDays', async () => {
    await settings({ ...keys.withIpqs, cache: { flaggedDays: 14, cleanDays: 3 } });
    await checkNumber(d(), SPAMMER);
    await checkNumber(d(), CLEAN);
    await checkNumber(d(), SPAMMER);
    await checkNumber(d(), CLEAN);
    expect(urls).toHaveLength(2);
    const days = await t.db.execute<{ number: string; days: number }>(
      sql`select number, round(extract(epoch from expires_at - now()) / 86400)::int as days from spam_lookups order by number`,
    );
    expect(days.rows).toEqual([
      { number: SPAMMER, days: 14 },
      { number: CLEAN, days: 3 },
    ]);
    // An expired answer is asked again.
    await t.db.update(spamLookups).set({ expiresAt: sql`now() - interval '1 second'` });
    await checkNumber(d(), CLEAN);
    expect(urls).toHaveLength(3);
  });

  it('a check under way is shared: five at once cost one request', async () => {
    await settings(keys.withIpqs);
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => checkNumber(d(), SPAMMER)));
    expect(new Set(all.map((a) => a?.risk))).toEqual(new Set(['high']));
    expect(urls).toHaveLength(1);
  });

  it('IPQualityScore failing: one warning without the key, nothing cached, the FTC answers', async () => {
    await settings({ ...keys.withIpqs, ...keys.withFtc });
    for (const mode of ['down', 'slow'] as const) {
      ipqs = mode;
      expect(await checkNumber(d(), REPORTED)).toEqual({
        risk: 'high',
        provider: 'ftc',
        info: {
          complaints: 3,
          robocalls: 2,
          lastReportedAt: expect.any(String),
          subject: 'Warranties',
        },
      });
    }
    expect(log.warn.mock.calls.map((c) => c[0])).toEqual([
      { provider: 'ipqs', reason: 'HTTP 503' },
      { provider: 'ipqs', reason: 'no answer in 4 s' },
    ]);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(IPQS_KEY);
    expect(await t.db.select().from(spamLookups)).toEqual([]);
  });

  it('without IPQualityScore the FTC list answers; without either, nothing', async () => {
    ipqs = 'down';
    await settings(keys.withFtc);
    expect((await checkNumber(d(), SHADY))?.info).toEqual({
      complaints: 1,
      robocalls: 0,
      lastReportedAt: expect.any(String),
      subject: null,
    });
    expect((await checkNumber(d(), SHADY))?.risk).toBe('medium');
    expect(await checkNumber(d(), CLEAN)).toMatchObject({ risk: 'low', provider: 'ftc' });
    expect(urls).toEqual([]);
    await settings({});
    expect(await checkNumber(d(), REPORTED)).toBeNull();
  });

  it('out of credits: paused once, the FTC answers, the warning, Dismiss, and back', async () => {
    await settings({ ...keys.withIpqs, ...keys.withFtc });
    const warning = async () =>
      (await admin('GET', '/api/system/warnings'))
        .json()
        .items.find((w: { code: string }) => w.code === 'spam_quota');
    const events = async () =>
      (
        await t.db
          .select({ code: systemEvents.code })
          .from(systemEvents)
          .where(like(systemEvents.code, 'spam.%'))
          .orderBy(systemEvents.createdAt)
      ).map((e) => e.code);
    ipqs = 'exhausted';
    const both = await Promise.all([checkNumber(d(), REPORTED), checkNumber(d(), SHADY)]);
    expect(both.map((a) => a?.provider)).toEqual(['ftc', 'ftc']);
    expect((await getSetting(t.db, 'spam.state')).ipqsPausedAt).not.toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(await events()).toEqual(['spam.quotaExhausted']);
    expect(await warning()).toEqual({
      code: 'spam_quota',
      message:
        "IPQualityScore's lookups are used up. Spam checks use the FTC list until they come back.",
      link: '/admin/settings/spam',
      dismissable: true,
    });

    // Paused: IPQualityScore isn't asked and nothing is logged.
    urls.length = 0;
    expect((await checkNumber(d(), CLEAN))?.provider).toBe('ftc');
    expect(urls).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(1);

    expect((await admin('POST', '/api/system/warnings/spam_quota/dismiss')).statusCode).toBe(200);
    expect(await warning()).toBeUndefined();

    credits = 0;
    await spamQuotaCheck(t.db);
    expect((await getSetting(t.db, 'spam.state')).ipqsPausedAt).not.toBeNull();
    credits = 5;
    await spamQuotaCheck(t.db);
    expect((await getSetting(t.db, 'spam.state')).ipqsPausedAt).toBeNull();
    expect(await events()).toEqual(['spam.quotaExhausted', 'spam.quotaRestored']);
    ipqs = 'ok';
    expect((await checkNumber(d(), SPAMMER))?.provider).toBe('ipqs');

    // Out again: the warning comes back though it was dismissed; without the FTC list, "off".
    await settings(keys.withIpqs);
    ipqs = 'exhausted';
    expect(await checkNumber(d(), SHADY)).toBeNull();
    expect((await warning())?.message).toBe(
      "IPQualityScore's lookups are used up. Spam checks are off until they come back.",
    );

    // A new key doesn't wait for the job.
    const r = await admin('PATCH', '/api/settings', {
      spam: {
        ...SPAM_DEFAULTS,
        enabled: true,
        ipqs: { key: IPQS_KEY },
      },
    });
    expect(r.statusCode).toBe(200);
    expect((await getSetting(t.db, 'spam.state')).ipqsPausedAt).toBeNull();
    expect(await warning()).toBeUndefined();
  });

  it('spamQuotaCheck asks nothing unless paused, and a failure throws without the key', async () => {
    await settings(keys.withIpqs);
    await spamQuotaCheck(t.db);
    expect(urls).toEqual([]);
    await setSetting(t.db, 'spam.state', {
      ...(await getSetting(t.db, 'spam.state')),
      ipqsPausedAt: new Date().toISOString(),
    });
    await settings({ ipqs: { keyEnc: encrypt('wrong-key') } });
    const err = await spamQuotaCheck(t.db).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe('Invalid or unauthorized key: ***');
    expect((await getSetting(t.db, 'spam.state')).ipqsPausedAt).not.toBeNull();
  });

  it('cachedOnly never asks IPQualityScore', async () => {
    await settings({ ...keys.withIpqs, ...keys.withFtc });
    expect((await checkNumber(d(), REPORTED, { cachedOnly: true }))?.provider).toBe('ftc');
    await checkNumber(d(), SPAMMER);
    expect((await checkNumber(d(), SPAMMER, { cachedOnly: true }))?.provider).toBe('ipqs');
    expect(urls).toHaveLength(1);
  });

  describe('Settings → Spam check', () => {
    const body = (s: Record<string, unknown> = {}) => ({
      spam: {
        enabled: true,
        ipqs: { key: IPQS_KEY },
        ftc: null,
        cache: { flaggedDays: 14, cleanDays: 3 },
        deskPhoneLabels: { high: 'SPAM LIKELY', medium: 'Spam risk' },
        ...s,
      },
    });

    it('Download now: due at the next minute; refused without the FTC list', async () => {
      await settings(keys.withIpqs);
      const r = await admin('POST', '/api/settings/spam/ftc/sync');
      expect(r.statusCode).toBe(400);
      expect(r.body).toMatch('Set up the FTC list first');
      await settings(keys.withFtc);
      await setSetting(t.db, 'spam.state', {
        ...(await getSetting(t.db, 'spam.state')),
        ftcLastSyncAt: new Date().toISOString(),
      });
      expect((await admin('POST', '/api/settings/spam/ftc/sync')).statusCode).toBe(200);
      expect((await getSetting(t.db, 'spam.state')).ftcLastSyncAt).toBeNull();
    });

    it('keys are write-only, and empty keeps the saved one', async () => {
      await setSetting(t.db, 'spam', SPAM_DEFAULTS);
      const r = await admin('PATCH', '/api/settings', body());
      expect(r.statusCode).toBe(200);
      expect(r.json().spam).toEqual({
        ...SPAM_DEFAULTS,
        enabled: true,
        ipqs: { hasKey: true },
      });
      expect(r.body).not.toContain(IPQS_KEY);
      const saved = (await getSetting(t.db, 'spam')).ipqs!.keyEnc;
      expect((await admin('PATCH', '/api/settings', body({ ipqs: {} }))).statusCode).toBe(200);
      expect((await getSetting(t.db, 'spam')).ipqs!.keyEnc).toBe(saved);
      const [a] = await t.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.summary, 'Changed settings: spam'));
      expect(JSON.stringify(a!.diff)).not.toContain(saved);
    });

    it('refuses a provider without a key, nothing to check with, and odd labels', async () => {
      await setSetting(t.db, 'spam', SPAM_DEFAULTS);
      const no = async (b: unknown, error: RegExp) => {
        const r = await admin('PATCH', '/api/settings', b);
        expect(r.statusCode).toBe(400);
        expect(r.body).toMatch(error);
      };
      await no(body({ ipqs: {} }), /Enter the IPQualityScore key/);
      await no(
        body({ ipqs: null, ftc: { syncHours: 24, windowDays: 30 } }),
        /Enter the api.data.gov key/,
      );
      await no(body({ ipqs: null }), /Set up IPQualityScore or the FTC list/);
      await no(body({ deskPhoneLabels: { high: 'Spam?', medium: 'Spam risk' } }), /Letters/);
      await no(
        body({ ftc: { key: FTC_KEY, syncHours: 0, windowDays: 30 } }),
        /syncHours|too small|>=1/i,
      );
      await no({ 'spam.state': { ipqsPausedAt: null } }, /can't be changed/);
      // Off with no provider is fine.
      expect(
        (await admin('PATCH', '/api/settings', body({ enabled: false, ipqs: null }))).statusCode,
      ).toBe(200);
    });

    it('Test uses the typed key, else the saved one, and never shows it', async () => {
      await setSetting(t.db, 'spam', SPAM_DEFAULTS);
      const test = async (provider: string, key?: string) =>
        (await admin('POST', `/api/settings/spam/${provider}/test`, { key })).json();
      expect(await test('ipqs')).toEqual({ ok: false, error: 'Enter the key first' });
      expect(await test('ipqs', IPQS_KEY)).toEqual({
        ok: true,
        detail: 'Works: 912 credits left this billing period.',
      });
      const bad = await test('ipqs', 'wrong-key-789');
      expect(bad.ok).toBe(false);
      expect(JSON.stringify(bad)).not.toContain('wrong-key-789');
      await settings({ ...keys.withIpqs, ...keys.withFtc });
      expect((await test('ipqs')).ok).toBe(true);
      expect(await test('ftc')).toEqual({ ok: true, detail: 'The FTC answered.' });
      expect(await test('ftc', 'nope')).toEqual({
        ok: false,
        error: 'api.data.gov refused the key',
      });
    });
  });
});
