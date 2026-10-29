// SPDX-License-Identifier: AGPL-3.0-or-later
// Fraud alerts (08 §8.3): risky calls the PBX placed, voip.ms calls it didn't place, and a
// balance that drops fast. Each is an email to every admin and a warning event.
import { and, eq, gt, gte, isNotNull, like, lte } from 'drizzle-orm';
import { formatNumber } from '@selfphoneng/shared';
import type { Db } from '../db/client.ts';
import { calls, cdr, dids, trunks } from '../db/schema.ts';
import { decrypt } from '../crypto/secrets.ts';
import {
  getBalance,
  getCdr,
  VoipmsError,
  type VoipmsCall,
  type VoipmsCreds,
} from '../integrations/voipms/client.ts';
import { logEvent } from './events.ts';
import { getSetting } from './settings.ts';

/** NANP area codes outside the US and Canada: dialed like a home call, billed like abroad. (verify) */
const ABROAD_NANP = new Set(
  '242 246 264 268 284 345 441 473 649 658 664 721 758 767 784 809 829 849 868 869 876'.split(' '),
);

/** Why a dialed number is worth an email, or null. 10 digits count as 1 + them. */
export function riskyDestination(dialed: string): string | null {
  const n = /^[2-9]\d{9}$/.test(dialed) ? `1${dialed}` : dialed;
  if (n.startsWith('011')) return 'international';
  const m = /^1(\d{3})(\d{3})\d{4}$/.exec(n);
  if (!m) return null;
  if (m[1] === '900' || m[2] === '976') return 'premium';
  if (ABROAD_NANP.has(m[1]!)) return 'international rates (outside the US and Canada)';
  return null;
}

/** The number a trunk Dial sent (`PJSIP/<number>@trunk-<id>,120`), or null. */
export const trunkDialNumber = (lastdata: string | null): string | null =>
  /^PJSIP\/([^@]+)@trunk-/.exec(lastdata ?? '')?.[1] ?? null;

const tail = (n: string) => n.replace(/\D/g, '').slice(-10);
const MIN = 60_000;
const day = (d: Date) => d.toISOString().slice(0, 10);

export type FraudDeps = {
  db: Db;
  voipmsUrl: string;
  mail: (subject: string, text: string) => Promise<void>;
  log: { warn(o: object, m: string): void };
  now: () => Date;
};

export function createFraudWatch(d: FraudDeps) {
  const when = async (at: Date) =>
    new Intl.DateTimeFormat('en-US', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: await getSetting(d.db, 'general.timezone'),
    }).format(at);
  const warn = (code: string, source: string, message: string) =>
    logEvent(d.db, { severity: 'warning', code, source, message });

  // Calls are read 10 s behind the clock, so a row whose insert is still committing isn't skipped.
  // ponytail: the cursor starts at api start; a call made while the api was down has no row anyway.
  let since = new Date(d.now().getTime() - 10_000);
  const riskyCallWatch = async () => {
    const until = new Date(d.now().getTime() - 10_000);
    const rows = await d.db
      .select()
      .from(calls)
      .where(
        and(
          eq(calls.direction, 'outbound'),
          gt(calls.createdAt, since),
          lte(calls.createdAt, until),
        ),
      )
      .orderBy(calls.createdAt);
    since = until;
    if (!(await getSetting(d.db, 'alerts.riskyCalls'))) return;
    const lines: string[] = [];
    for (const c of rows) {
      const why = riskyDestination(c.toNumber ?? '');
      if (why)
        lines.push(
          `${await when(c.startedAt)}  from ${c.fromNumber ?? '?'} to ${formatNumber(c.toNumber!)}: ` +
            `${why}, ${c.status}, ${c.talkSeconds} s talking`,
        );
    }
    if (!lines.length) return;
    await warn(
      'fraud.risky_call',
      'Fraud alerts',
      `${lines.length} call(s) to international or premium numbers`,
    );
    await d.mail(
      `Calls to risky numbers (${lines.length})`,
      'The phone system placed calls to numbers that can cost a lot:\n\n' +
        `${lines.join('\n')}\n\n` +
        "If you don't recognise them, someone may have a phone's password: change it " +
        '(Extensions → the extension → New SIP password) and check Outbound rules.\n' +
        'These emails can be turned off on Settings → Security → Fraud alerts.',
    );
  };

  // voip.ms records already reported, for 3 hours (08 §8.3).
  const reported = new Map<string, number>();
  async function callCheck(t: { name: string; username: string }, creds: VoipmsCreds) {
    const now = d.now().getTime();
    for (const [id, at] of reported) if (at < now - 180 * MIN) reported.delete(id);
    const from = new Date(now - 120 * MIN);
    const to = new Date(now - 10 * MIN);
    // uniqueid isn't in voip.ms's examples (06 §5.1), so the time and number make the key too.
    const key = (r: VoipmsCall) => `${r.uniqueid}|${r.at.getTime()}|${r.destination}`;
    const records = (
      await getCdr(d.voipmsUrl, creds, { from: day(from), to: day(to), account: t.username })
    ).filter((r) => r.at >= from && r.at <= to && !reported.has(key(r)));
    if (!records.length) return;
    const ours = new Set((await d.db.select({ n: dids.number }).from(dids)).map((x) => tail(x.n)));
    // Every call the PBX sent to a trunk, forwards and 911 included (03 §6.12, §6.14).
    const sent = (
      await d.db
        .select({ at: cdr.startAt, data: cdr.lastdata })
        .from(cdr)
        .where(
          and(
            like(cdr.lastdata, 'PJSIP/%@trunk-%'),
            gte(cdr.startAt, new Date(from.getTime() - 5 * MIN)),
            lte(cdr.startAt, new Date(to.getTime() + 5 * MIN)),
          ),
        )
    ).flatMap((r) => {
      const n = trunkDialNumber(r.data);
      return n && r.at ? [{ n: tail(n), at: r.at.getTime() }] : [];
    });
    const strange: VoipmsCall[] = [];
    for (const r of records) {
      reported.set(key(r), r.at.getTime());
      if (r.account && r.account !== t.username) continue;
      if (ours.has(tail(r.destination))) continue; // incoming, to one of our numbers
      const i = sent.findIndex(
        (s) => s.n === tail(r.destination) && Math.abs(s.at - r.at.getTime()) <= 5 * MIN,
      );
      if (i >= 0) sent.splice(i, 1);
      else strange.push(r);
    }
    if (!strange.length) return;
    const lines = await Promise.all(
      strange.map(
        async (r) =>
          `${await when(r.at)}  to ${r.destination}: ${r.disposition.toLowerCase() || '?'}, ` +
          `${r.seconds} s, cost ${r.total}`,
      ),
    );
    await warn(
      'fraud.provider_call',
      `Trunk ${t.name}`,
      `voip.ms has ${strange.length} call(s) on ${t.username} that this phone system didn't make`,
    );
    await d.mail(
      `voip.ms calls this phone system didn't make (${strange.length})`,
      `voip.ms billed these calls on sub-account ${t.username} (trunk ${t.name}), and this ` +
        'phone system has no record of making them:\n\n' +
        `${lines.join('\n')}\n\n` +
        'Someone else may have the sub-account password. At voip.ms: change the sub-account ' +
        "password (then paste it on Trunks), and turn on its IP restriction with this server's " +
        'public IP. Check the voip.ms call records too.\n' +
        'A call made while SelfPhoneNG was restarting, or by another device using the same ' +
        'sub-account, also shows up here.\n' +
        'These emails can be turned off on Settings → Security → Fraud alerts.',
    );
  }

  // Balance samples per API login (one account can have several trunks), the last hour's.
  const balances = new Map<string, { at: number; v: number }[]>();
  const balanceMailed = new Map<string, number>();
  async function balanceCheck(creds: VoipmsCreds, limit: number) {
    const now = d.now().getTime();
    const v = await getBalance(d.voipmsUrl, creds);
    const samples = [
      ...(balances.get(creds.username) ?? []).filter((s) => s.at >= now - 60 * MIN),
      { at: now, v },
    ];
    balances.set(creds.username, samples);
    const high = Math.max(...samples.map((s) => s.v));
    if (high - v <= limit || (balanceMailed.get(creds.username) ?? 0) > now - 60 * MIN) return;
    balanceMailed.set(creds.username, now);
    const drop = (high - v).toFixed(2);
    await warn(
      'fraud.balance_drop',
      'Fraud alerts',
      `The voip.ms balance dropped ${drop} in an hour`,
    );
    await d.mail(
      `voip.ms balance dropped ${drop} in an hour`,
      `The voip.ms balance of ${creds.username} went from ${high.toFixed(2)} to ${v.toFixed(2)} ` +
        `within the last hour, more than the ${limit} set on Settings → Security → Fraud alerts.\n\n` +
        "If that isn't your own calling, check the call records at voip.ms, change the " +
        'sub-account and API passwords, and turn on IP restriction on the sub-account.',
    );
  }

  const providerWatch = async () => {
    const checkCalls = await getSetting(d.db, 'alerts.providerCalls');
    const limit = await getSetting(d.db, 'alerts.balanceDropPerHour');
    if (!checkCalls && !limit) return;
    const rows = await d.db
      .select({
        name: trunks.name,
        username: trunks.username,
        apiUser: trunks.voipmsApiUsername,
        apiPass: trunks.voipmsApiPasswordEnc,
      })
      .from(trunks)
      .where(
        and(
          eq(trunks.enabled, true),
          eq(trunks.provider, 'voipms'),
          isNotNull(trunks.voipmsApiUsername),
          isNotNull(trunks.voipmsApiPasswordEnc),
        ),
      );
    const balanceAsked = new Set<string>();
    for (const t of rows) {
      const creds = { username: t.apiUser!, password: decrypt(t.apiPass!) };
      try {
        if (checkCalls && t.username)
          await callCheck({ name: t.name, username: t.username }, creds);
        if (limit && !balanceAsked.has(creds.username)) {
          balanceAsked.add(creds.username);
          await balanceCheck(creds, limit);
        }
      } catch (e) {
        if (!(e instanceof VoipmsError)) throw e;
        d.log.warn({ trunk: t.name, status: e.status }, 'voip.ms fraud check failed');
      }
    }
  };

  return { riskyCallWatch, providerWatch };
}
