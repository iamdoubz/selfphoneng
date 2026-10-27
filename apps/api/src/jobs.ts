// SPDX-License-Identifier: AGPL-3.0-or-later
// Background jobs (04 §8) on one once-a-minute timer.
// ponytail: setInterval instead of croner: every schedule in 04 §8 is a whole number of minutes.
import { statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from './config.ts';
import type { Db } from './db/client.ts';
import {
  extensions,
  sessions,
  spamLookups,
  systemEvents,
  trunks,
  users,
  voicemailMessages,
  webhookDeliveries,
} from './db/schema.ts';
import type { Generator } from './generator/index.ts';
import { todayIn } from './generator/load.ts';
import type { LiveState } from './live/state.ts';
import { cleanupContactShares } from './routes/contacts.ts';
import { cleanupRecordings } from './routes/recordings.ts';
import { transcribeCalls } from './ai/calls.ts';
import { audit } from './services/audit.ts';
import { backupDue, runBackup } from './services/backup.ts';
import { sendCallReports } from './services/callreport.ts';
import { contrackBook, contrackSettings } from './contacts/contrack.ts';
import { logCallsToContrack } from './contacts/timeline.ts';
import { checkDirectory } from './sso/directory.ts';
import { checkOidcSessions } from './sso/oidcCheck.ts';
import { logEvent } from './services/events.ts';
import { deliverDue } from './services/webhooks.ts';
import type { SendMail } from './services/mail.ts';
import { getSetting, setSetting } from './services/settings.ts';

export type JobDeps = {
  config: Config;
  db: Db;
  ami: { isConnected(): boolean; action(f: Record<string, string>): Promise<unknown> };
  live: Pick<LiveState, 'snapshot' | 'amiConnected'>;
  generator: Pick<Generator, 'apply'>;
  voicemail: { scan(ext: string): Promise<void> };
  send: SendMail;
  log: { info(o: object, m: string): void; error(o: object, m: string): void };
  now?: () => Date;
  statfs?: typeof statfs;
};

/** The server's public IPv4 as an outside service sees it, or null. */
export async function detectPublicIp(): Promise<string | null> {
  for (const url of ['https://api.ipify.org', 'https://ifconfig.me/ip']) {
    const ip = await fetch(url, { signal: AbortSignal.timeout(5000) })
      .then((r) => (r.ok ? r.text() : ''))
      .catch(() => '');
    if (z.ipv4().safeParse(ip.trim()).success) return ip.trim();
  }
  return null;
}

/** Email every active admin (08 §3.2). Email not set up or failing is logged, not thrown. */
export async function mailAdmins(d: JobDeps, subject: string, text: string) {
  const to = (
    await d.db
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.isActive, true)))
  ).map((r) => r.email);
  if (to.length)
    await d.send({ to, subject, text }).catch((err: unknown) => d.log.error({ err }, subject));
}

/** Recordings, voicemail, expired sessions, old webhook deliveries and spam check answers
 *  (04 §8 retentionCleanup, 14 §4). */
export async function retentionCleanup(d: JobDeps) {
  const recordings = await cleanupRecordings(
    d.db,
    resolve(d.config.RECORDINGS_DIR),
    await getSetting(d.db, 'recordings.retentionDays'),
  );
  let voicemail = 0;
  const vmDays = await getSetting(d.db, 'voicemail.retentionDays');
  // Asterisk removes the files and renumbers the folder (the caller waits for AMI).
  if (vmDays > 0) {
    const old = await d.db
      .select({
        ext: extensions.number,
        folder: voicemailMessages.folder,
        msgId: voicemailMessages.msgId,
      })
      .from(voicemailMessages)
      .innerJoin(extensions, eq(extensions.id, voicemailMessages.extensionId))
      .where(
        and(
          isNull(voicemailMessages.deletedAt),
          lt(voicemailMessages.receivedAt, sql`now() - make_interval(days => ${vmDays})`),
        ),
      );
    for (const m of old)
      await d.ami.action({
        Action: 'VoicemailRemove',
        Context: 'default',
        Mailbox: m.ext,
        Folder: m.folder,
        ID: m.msgId,
      });
    for (const ext of new Set(old.map((m) => m.ext))) await d.voicemail.scan(ext);
    voicemail = old.length;
  }
  await d.db.delete(sessions).where(lt(sessions.expiresAt, sql`now()`));
  await d.db
    .delete(webhookDeliveries)
    .where(lt(webhookDeliveries.createdAt, sql`now() - interval '30 days'`));
  await d.db
    .delete(systemEvents)
    .where(lt(systemEvents.createdAt, sql`now() - interval '90 days'`));
  await d.db.delete(spamLookups).where(lt(spamLookups.expiresAt, sql`now()`));
  await cleanupContactShares(d.db);
  if (recordings || voicemail) d.log.info({ recordings, voicemail }, 'old messages deleted');
}

/** The jobs, each keeping its own state (tests call them directly). */
export function createJobs(d: JobDeps) {
  const now = d.now ?? (() => new Date());
  const tz = () => getSetting(d.db, 'general.timezone');

  // Holidays roll over at midnight (03 §6.10): render again when the local date changes.
  // Retention runs then too (and at start), not at 02:00.
  let lastDay = '';
  let cleanedDay = '';
  const daily = async () => {
    const today = todayIn(await tz(), now());
    if (lastDay && today !== lastDay) await d.generator.apply({ trigger: 'nightly', force: true });
    lastDay = today;
    // Voicemail goes through Asterisk: at start, wait the few seconds until AMI is connected.
    if (cleanedDay !== today && d.ami.isConnected()) {
      await retentionCleanup(d);
      cleanedDay = today;
    }
  };

  let backupTriedDay = ''; // one try a day: a failing pg_dump shouldn't run every minute
  const backup = async () => {
    const today = todayIn(await tz(), now());
    if (backupTriedDay === today || !(await backupDue(d.config, d.db, now()))) return;
    backupTriedDay = today;
    try {
      const b = await runBackup(d.config, d.db);
      d.log.info({ backup: b.name, size: b.size }, 'backup made');
      await logEvent(d.db, {
        severity: 'info',
        code: 'backup.done',
        source: 'Backup',
        message: `Daily backup ${b.name} made (${Math.round(b.size / 1e6)} MB)`,
      });
    } catch (err) {
      await logEvent(d.db, {
        severity: 'error',
        code: 'backup.failed',
        source: 'Backup',
        message: `Daily backup failed: ${(err as Error).message}`,
      });
      await mailAdmins(d, 'Backup failed', `Today's backup failed: ${(err as Error).message}`);
      throw err;
    }
  };

  const publicIpWatch = async () => {
    if (!(await getSetting(d.db, 'network.publicIpWatch'))) return;
    const ip = await detectPublicIp();
    const old = await getSetting(d.db, 'network.publicIp');
    if (!ip || ip === old) return;
    await setSetting(d.db, 'network.publicIp', ip);
    await audit(d.db, {
      action: 'settings',
      summary: `Public IP changed from ${old ?? 'none'} to ${ip}`,
      diff: { before: old, after: ip },
    });
    await logEvent(d.db, {
      severity: 'warning',
      code: 'network.publicIpChanged',
      source: 'Network',
      message: `Public IP changed from ${old ?? 'none'} to ${ip}`,
    });
    await d.generator.apply({ trigger: 'publicIp', force: true }); // sets restartRequired
    await mailAdmins(
      d,
      `Public IP changed to ${ip}`,
      `The phone system's public IP changed from ${old ?? 'none'} to ${ip}.\n` +
        'Restart telephony so calls use the new address: Admin → System says how (it drops calls in progress).\n' +
        'Phones and the provider may need the new IP if they were set up with the old one.',
    );
  };

  // A registering trunk that stays down for 5 minutes: one email per outage.
  const downSince = new Map<string, number>();
  const mailed = new Set<string>();
  const trunkWatch = async () => {
    if (!d.live.amiConnected) return; // Asterisk itself being down shows elsewhere
    const state = new Map((d.live.snapshot(true).trunks ?? []).map((t) => [t.trunkId, t]));
    const rows = await d.db
      .select({ id: trunks.id, name: trunks.name })
      .from(trunks)
      .where(eq(trunks.enabled, true));
    for (const t of rows) {
      const reg = state.get(t.id)?.registration;
      // ponytail: IP-auth trunks don't register (always 'unknown'), so they're never "down" here.
      if (reg !== 'rejected' && reg !== 'unregistered') {
        downSince.delete(t.id);
        mailed.delete(t.id);
        continue;
      }
      const since = downSince.get(t.id) ?? now().getTime();
      downSince.set(t.id, since);
      if (now().getTime() - since < 5 * 60_000 || mailed.has(t.id)) continue;
      mailed.add(t.id);
      await mailAdmins(
        d,
        `Trunk ${t.name} is down`,
        `Trunk ${t.name} has not been registered with the provider since ` +
          `${new Date(since).toISOString()} (${reg}). Calls through it fail.\n` +
          'Check Trunks → Test, the account password, and the provider status.',
      );
    }
  };

  let diskMailedDay = '';
  const diskWatch = async () => {
    const fs = await (d.statfs ?? statfs)(resolve(d.config.RECORDINGS_DIR));
    const free = fs.bavail / fs.blocks;
    const today = todayIn(await tz(), now());
    if (free >= 0.1 || diskMailedDay === today) return;
    diskMailedDay = today;
    await logEvent(d.db, {
      severity: 'warning',
      code: 'disk.low',
      source: 'Disk',
      message: `Disk almost full: ${Math.round(free * 100)}% free`,
    });
    await mailAdmins(
      d,
      `Disk almost full (${Math.round(free * 100)}% free)`,
      `Only ${Math.round((fs.bavail * fs.bsize) / 1e9)} GB (${Math.round(free * 100)}%) is free ` +
        'on the phone system. Recordings, voicemail and backups stop being saved when it fills.\n' +
        'Lower the recording retention (Settings → Recording) or free up space.',
    );
  };

  /** Contrack books warmed every 5 minutes, so a ringing phone's lookup finds them (11 §6 C4). */
  const contactsWarm = async () => {
    const c = await contrackSettings(d.db);
    if (!c) return;
    const owners = await d.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.isActive, true), isNotNull(users.contrackTokenEnc)));
    for (const owner of [null, ...owners.map((o) => o.id)]) await contrackBook(d.db, c, owner);
  };

  const callReports = async () => {
    await sendCallReports({ db: d.db, send: d.send, log: d.log, now: now() });
  };

  const contrackLog = async () => {
    await logCallsToContrack({ db: d.db, log: d.log, now: now() });
  };

  /** OpenID sessions refreshed at the provider; a leaver's end (12 §3.5). */
  const oidcCheck = async () => {
    await checkOidcSessions({ db: d.db, log: d.log, now: now() });
  };

  /** Directory accounts re-read; a leaver disabled (12 §4.5). */
  const directoryCheck = async () => {
    await checkDirectory({ db: d.db, log: d.log });
  };

  return {
    oidcCheck,
    directoryCheck,
    daily,
    backup,
    publicIpWatch,
    trunkWatch,
    diskWatch,
    callReports,
    contactsWarm,
    contrackLog,
  };
}

/** Starts the jobs; returns a stop function. */
export function startJobs(d: JobDeps): () => void {
  const j = createJobs(d);
  // Every job: never two runs of itself at once (04 §8), errors logged.
  const running = new Set<string>();
  const run = (name: string, fn: () => Promise<void>) => {
    if (running.has(name)) return;
    running.add(name);
    void fn()
      .catch((err: unknown) => d.log.error({ err }, `job ${name} failed`))
      .finally(() => running.delete(name));
  };
  let minute = 0;
  const tick = () => {
    run('daily', j.daily);
    run('backup', j.backup);
    run('trunkWatch', j.trunkWatch);
    if (minute % 5 === 0) run('publicIpWatch', j.publicIpWatch);
    if (minute % 60 === 0) run('diskWatch', j.diskWatch);
    run('callReports', j.callReports);
    if (minute % 5 === 0) run('contactsWarm', j.contactsWarm);
    run('contrackLog', j.contrackLog);
    if (minute % 5 === 0) run('oidcCheck', j.oidcCheck);
    if (minute % 60 === 0) run('directoryCheck', j.directoryCheck);
    run('callTranscripts', async () => {
      await transcribeCalls({ db: d.db, dir: resolve(d.config.RECORDINGS_DIR), log: d.log });
    });
    minute++;
  };
  tick();
  const timer = setInterval(tick, 60_000);
  const hooks = setInterval(() => run('webhookDelivery', () => deliverDue(d.db)), 10_000);
  return () => {
    clearInterval(timer);
    clearInterval(hooks);
  };
}
