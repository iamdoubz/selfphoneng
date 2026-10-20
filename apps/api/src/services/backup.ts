// SPDX-License-Identifier: AGPL-3.0-or-later
// Backups (04 §8.1): BACKUPS_DIR/selfphoneng-YYYYMMDD-HHMM.tar.gz with db.sql (pg_dump), the
// voicemail, custom sounds and music-on-hold folders, optionally recordings, and manifest.json.
// No generated Asterisk config (plaintext SIP passwords; it's rebuilt from the DB on start).
// Restore is scripts/restore.sh only.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rename, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { BackupDto } from '@selfphoneng/shared';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { getSetting } from './settings.ts';

const run = promisify(execFile);
/** manifest.json `version`: the backup format, which restore.sh checks. */
export const BACKUP_FORMAT = 1;
export const BACKUP_NAME = /^selfphoneng-\d{8}-\d{4}\.tar\.gz$/;

/**
 * Lets restore.sh tell whether .env has the APP_SECRET the backup's encrypted columns need,
 * without putting the secret in the backup: `printf 'selfphoneng-backup:%s' "$APP_SECRET" |
 * sha256sum | cut -c1-16`.
 */
export const secretCheck = (appSecret: string) =>
  createHash('sha256').update(`selfphoneng-backup:${appSecret}`).digest('hex').slice(0, 16);

export type BackupSources = {
  databaseUrl: string;
  appSecret: string;
  outDir: string;
  /** archive folder name → folder on disk; missing folders are left out. */
  dirs: Record<string, string>;
  timezone: string;
};

/** "20261019-0330" in the PBX's time zone. */
export function stamp(timezone: string, now = new Date()): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}`;
}

export async function listBackups(dir: string): Promise<BackupDto[]> {
  const names = (await readdir(dir).catch(() => [])).filter((n) => BACKUP_NAME.test(n));
  const out = await Promise.all(
    names.map(async (name) => {
      const s = await stat(join(dir, name));
      return { name, size: s.size, createdAt: s.mtime.toISOString() };
    }),
  );
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

/** Makes one backup and keeps only the newest `keep`. Needs pg_dump and GNU tar (api image). */
export async function createBackup(
  src: BackupSources,
  opts: { keep: number; now?: Date },
): Promise<BackupDto> {
  const name = `selfphoneng-${stamp(src.timezone, opts.now)}.tar.gz`;
  const work = await mkdtemp(join(tmpdir(), 'sp-backup-'));
  const tmp = join(src.outDir, `.${name}.tmp`);
  try {
    // The password goes in the environment: `ps` on the host shows a container's arguments (M11-T8).
    const db = new URL(src.databaseUrl);
    const password = decodeURIComponent(db.password);
    db.password = '';
    await run('pg_dump', ['--no-owner', '--dbname', db.href, '--file', join(work, 'db.sql')], {
      env: { ...process.env, PGPASSWORD: password },
    });
    const included: string[] = [];
    const args = ['-czf', tmp, '-C', work, 'db.sql', 'manifest.json'];
    for (const [as, dir] of Object.entries(src.dirs)) {
      if (
        !(await stat(dir).then(
          (s) => s.isDirectory(),
          () => false,
        ))
      )
        continue;
      // `-C parent base`, renamed to its archive name: restore.sh untars into data/ as is.
      const base = basename(dir);
      args.push('-C', dirname(dir), base);
      if (base !== as) args.push(`--transform=s,^${base}\\(/\\|$\\),${as}\\1,`);
      included.push(as);
    }
    const manifest = {
      version: BACKUP_FORMAT,
      createdAt: (opts.now ?? new Date()).toISOString(),
      includesRecordings: included.includes('recordings'),
      folders: included,
      secretCheck: secretCheck(src.appSecret),
    };
    await writeFile(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await run('tar', args, { maxBuffer: 16 * 1024 * 1024 });
    await chmod(tmp, 0o600);
    await rename(tmp, join(src.outDir, name));
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(tmp, { force: true });
  }
  const all = await listBackups(src.outDir);
  for (const old of all.slice(opts.keep)) await rm(join(src.outDir, old.name), { force: true });
  return all.find((b) => b.name === name)!;
}

let running: Promise<BackupDto> | null = null;
const loadedAt = Date.now();

/** The daily job has had its chance (it checks every minute): still due now means it failed. */
export const backupMissed = async (config: Config, db: Db) =>
  Date.now() - loadedAt > 5 * 60_000 && (await backupDue(config, db));

/** A backup with the configured folders and settings; a second call joins the one in progress. */
export function runBackup(config: Config, db: Db): Promise<BackupDto> {
  running ??= (async () => {
    const [timezone, keep, withRecordings] = await Promise.all([
      getSetting(db, 'general.timezone'),
      getSetting(db, 'backup.keep'),
      getSetting(db, 'backup.includeRecordings'),
    ]);
    return createBackup(
      {
        databaseUrl: config.DATABASE_URL,
        appSecret: config.APP_SECRET,
        outDir: resolve(config.BACKUPS_DIR),
        timezone,
        dirs: {
          voicemail: resolve(config.VOICEMAIL_DIR),
          'sounds-custom': resolve(config.SOUNDS_DIR),
          moh: resolve(config.MOH_DIR),
          ...(withRecordings && { recordings: resolve(config.RECORDINGS_DIR) }),
        },
      },
      { keep },
    );
  })().finally(() => (running = null));
  return running;
}

/** The daily backup is due: enabled, past `backup.time` here, and none made today yet. */
export async function backupDue(config: Config, db: Db, now = new Date()): Promise<boolean> {
  if (!(await getSetting(db, 'backup.enabled'))) return false;
  const tz = await getSetting(db, 'general.timezone');
  const [day, hhmm] = stamp(tz, now).split('-');
  if (hhmm! < (await getSetting(db, 'backup.time')).replace(':', '')) return false;
  const made = await listBackups(resolve(config.BACKUPS_DIR));
  return !made.some((b) => b.name.startsWith(`selfphoneng-${day}-`));
}
