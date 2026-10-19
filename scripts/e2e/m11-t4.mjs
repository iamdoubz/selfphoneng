// SPDX-License-Identifier: AGPL-3.0-or-later
// M11-T4: the background jobs against a real Asterisk, with email to a local SMTP sink.
// - Settings → Network turns on the public IP watch, Settings → Recording sets voicemail retention.
// - A real voicemail, made 40 days old in the database, is removed through Asterisk when the api
//   starts (and the message files are gone).
// - The watch finds the real public IP (needs internet), saves it and emails the admins.
// - A trunk to a server that never answers is down for 5 minutes: one email (takes ~6 minutes).
// - Disk under 10% free emails the admins, otherwise nothing.
// Runs on the m2-live setup started with a voicemail dir, after m1-t4.mjs. This script starts and
// restarts the api itself (stop yours first), with the api's environment in its own:
//   DATABASE_URL AMI_PORT=15038 AMI_SECRET=m2-live-secret ASTERISK_CONFIG_DIR VOICEMAIL_DIR
//   API_PORT, ... (and the repo's .env for the rest)
// Usage: node scripts/e2e/m11-t4.mjs <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, statfsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launch } from './cdp.mjs';
import { smtpSink } from './smtp-sink.mjs';

const AST = 'sp-live-ast';
const EXT = '201';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...a) => {
  const r = spawnSync('docker', a, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const cli = (cmd) => docker('exec', AST, 'asterisk', '-rx', cmd).out;
const sql = (q) =>
  docker(
    'exec',
    'selfphoneng-postgres-1',
    'psql',
    '-U',
    'selfphoneng',
    '-d',
    new URL(process.env.DATABASE_URL).pathname.slice(1),
    '-tAc',
    q,
  ).out.trim();
const until = async (what, ms, fn) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    assert.ok(Date.now() < end, `timed out: ${what}`);
    await sleep(1000);
  }
};
const [email, pw, shotsDir] = process.argv.slice(2);
const base = `http://127.0.0.1:${process.env.API_PORT}`;
const repo = resolve(import.meta.dirname, '../..');
const box = join(process.env.VOICEMAIL_DIR, 'default', EXT, 'INBOX');

const { mails, server: smtp } = await smtpSink();
const mailed = (subject) => mails.some((m) => m.includes(`Subject: ${subject}`));

const log = createWriteStream(join(shotsDir, 'm11-t4-api.log'));
let apiProc;
const startApi = async () => {
  apiProc = spawn(
    process.execPath,
    [`--env-file=${repo}/.env`, '--conditions=source', `${repo}/apps/api/src/index.ts`],
    { stdio: ['ignore', 'pipe', 'pipe'] }, // cwd: where the web build is (./public)
  );
  apiProc.stdout.pipe(log, { end: false });
  apiProc.stderr.pipe(log, { end: false });
  await until('api up', 30_000, () =>
    fetch(`${base}/healthz`).then(
      (r) => r.ok,
      () => false,
    ),
  );
};
const stopApi = async () => {
  const gone = new Promise((r) => apiProc.once('exit', r));
  apiProc.kill();
  await gone;
};

let cookie;
const api = async (method, url, body) => {
  const r = await fetch(`${base}${url}`, {
    method,
    headers: {
      'x-requested-with': 'selfphoneng',
      cookie,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body && JSON.stringify(body),
  });
  const json = await r.json();
  assert.ok(r.ok, `${method} ${url}: ${r.status} ${JSON.stringify(json)}`);
  return json;
};
const signIn = async () => {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'selfphoneng' },
    body: JSON.stringify({ email, password: pw }),
  });
  assert.equal(r.status, 200, 'login');
  cookie = r.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
};

await startApi();
const p = await launch({ shotsDir });
try {
  await signIn();
  await api('PATCH', '/api/settings', {
    smtp: {
      host: '127.0.0.1',
      port: 2525,
      secure: false,
      username: '',
      from: 'PBX <pbx@example.com>',
    },
  });
  await api('POST', '/api/extensions', { number: EXT, name: 'Ann Lee' });
  // TEST-NET-1: nothing answers, so the registration never succeeds.
  await api('POST', '/api/trunks', {
    name: 'dead-provider',
    serverHost: '192.0.2.1',
    username: '999999_pbx',
    password: 'never-used-pw-1',
  });

  // The settings, in the browser.
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname.startsWith('/admin')`, 'signed in');
  await p.goto(`${base}/admin/settings/network`);
  await p.waitFor(`document.body.innerText.includes('Re-check the public IP')`, 'network tab');
  await p.fill('Public IP', '203.0.113.5');
  await p.evaluate(
    `[...document.querySelectorAll('label')].find((l) => l.innerText.includes('Re-check the public IP')).querySelector('input').click()`,
  );
  await p.click('Save');
  await p.waitFor(`document.body.innerText.includes('Saved.')`, 'network saved');
  await p.shot('m11-t4-01-network');
  await p.goto(`${base}/admin/settings/recording`);
  await p.waitFor(`document.body.innerText.includes('Keep voicemail for')`, 'recording tab');
  await p.fill('Keep voicemail for (days)', '30');
  await p.click('Save');
  await p.waitFor(`document.body.innerText.includes('Saved.')`, 'retention saved');
  const s = await api('GET', '/api/settings');
  assert.equal(s['network.publicIp'], '203.0.113.5');
  assert.equal(s['network.publicIpWatch'], true);
  assert.equal(s['voicemail.retentionDays'], 30);
  console.log('settings: public IP watch on, voicemail kept 30 days (saved in the browser)');

  // A real voicemail (Local channel waits out the greeting, then "speaks"), made old.
  cli(
    `channel originate Local/${EXT}@sp-vm-direct application Playback silence/10&silence/5&tt-weasels`,
  );
  await until(
    'voicemail saved',
    90_000,
    () => sql('select count(*) from voicemail_messages') === '1',
  );
  assert.ok(existsSync(join(box, 'msg0000.wav')), 'message file on disk');
  sql(`update voicemail_messages set received_at = now() - interval '40 days'`);
  mails.length = 0; // the voicemail email
  console.log('voicemail left and made 40 days old');

  // Restart: the jobs run at start.
  await stopApi();
  await startApi();
  await until('old voicemail removed', 90_000, () => !existsSync(join(box, 'msg0000.txt')));
  assert.ok(!existsSync(join(box, 'msg0000.wav')), 'audio removed too');
  await until(
    'row marked deleted',
    10_000,
    () => sql('select count(*) from voicemail_messages where deleted_at is null') === '0',
  );
  console.log('retention: Asterisk removed the 40-day-old voicemail');

  await until('public IP email', 60_000, () => mailed('Public IP changed to'));
  await signIn();
  const ip = (await api('GET', '/api/settings'))['network.publicIp'];
  assert.notEqual(ip, '203.0.113.5');
  assert.ok(mailed(`Public IP changed to ${ip}`));
  const warnings = (await api('GET', '/api/system/warnings')).items.map((w) => w.code);
  assert.ok(warnings.includes('restart_required'), `restart asked for: ${warnings}`);
  console.log(`public IP watch: found ${ip}, saved, restart required, admins emailed`);

  const disk = statfsSync(process.env.RECORDINGS_DIR ?? process.env.VOICEMAIL_DIR);
  const low = disk.bavail / disk.blocks < 0.1;
  await until('disk check', 10_000, () => !low || mailed('Disk almost full'));
  if (!low) assert.ok(!mailed('Disk almost full'));
  console.log(
    `disk watch: ${Math.round((100 * disk.bavail) / disk.blocks)}% free, ${low ? '' : 'no '}email`,
  );

  assert.ok(!mailed('Trunk dead-provider is down'), 'not before 5 minutes');
  assert.ok(!/dead-provider.*Registered/.test(cli('pjsip show registrations')));
  await until('trunk down email', 8 * 60_000, () => mailed('Trunk dead-provider is down'));
  await sleep(65_000); // one more check: still one email
  assert.equal(mails.filter((m) => m.includes('Subject: Trunk dead-provider is down')).length, 1);
  console.log('trunk watch: one email after 5 minutes down');
  console.log('M11-T4: PASS');
} finally {
  await p.close();
  await stopApi();
  smtp.close();
  log.end();
}
