// SPDX-License-Identifier: AGPL-3.0-or-later
// M4-T2 acceptance: a voicemail left in Asterisk is emailed within 10 s with a playable wav.
// Runs on the m2-live setup started with a voicemail dir (m2-live.mjs up <confDir> <vmDir>) and the
// api started with VOICEMAIL_DIR=<vmDir>, after m1-t4.mjs. Runs its own SMTP sink on 127.0.0.1:2525.
// The caller is a Local channel playing a sound file, so no phones are needed.
// Usage: node scripts/e2e/m4-t2.mjs <baseUrl> <adminEmail> <adminPassword> <vmDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { smtpSink } from './smtp-sink.mjs';

const AST = 'sp-live-ast';
const EXT = '150';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (cmd) =>
  spawnSync('docker', ['exec', AST, 'asterisk', '-rx', cmd], { encoding: 'utf8' }).stdout ?? '';
const [base, email, pw, vmDir] = process.argv.slice(2);

const { mails, server } = await smtpSink();
try {
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'selfphoneng' },
    body: JSON.stringify({ email, password: pw }),
  });
  assert.equal(login.status, 200, 'admin login');
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const api = async (method, url, body) => {
    const r = await fetch(`${base}${url}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-requested-with': 'selfphoneng', cookie },
      body: body && JSON.stringify(body),
    });
    const json = await r.json();
    assert.ok(r.ok, `${method} ${url}: ${r.status} ${JSON.stringify(json)}`);
    return json;
  };

  await api('PATCH', '/api/settings', {
    smtp: {
      host: '127.0.0.1',
      port: 2525,
      secure: false,
      username: '',
      from: 'PBX <pbx@example.com>',
    },
  });
  const user = await api('POST', '/api/users', {
    email: 'val@example.com',
    displayName: 'Val Mail',
  });
  await api('POST', '/api/extensions', {
    number: EXT,
    name: 'Val Mail',
    userId: (user.user ?? user).id,
  });
  for (
    let i = 0;
    i < 20 && !new RegExp(`^default\\s+${EXT}\\s`, 'm').test(cli('voicemail show users'));
    i++
  )
    await sleep(500);
  assert.match(
    cli('voicemail show users'),
    new RegExp(`^default\\s+${EXT}\\s`, 'm'),
    'mailbox in Asterisk',
  );
  console.log(`mailbox ${EXT} configured`);

  // Straight to voicemail; the "caller" waits out the greeting, then speaks (~6 s).
  cli(
    `channel originate Local/${EXT}@sp-vm-direct application Playback silence/10&silence/5&tt-weasels&tt-weasels`,
  );
  const txt = join(vmDir, 'default', EXT, 'INBOX', 'msg0000.txt');
  for (let i = 0; i < 240 && !existsSync(txt); i++) await sleep(250);
  assert.ok(existsSync(txt), 'Asterisk saved the message');
  const t0 = Date.now();
  console.log('message saved');

  while (!mails.length && Date.now() - t0 < 10_000) await sleep(100);
  assert.equal(mails.length, 1, 'one email within 10 s');
  console.log(`email arrived after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const raw = mails[0];
  assert.match(raw, /^To: val@example\.com$/m);
  assert.match(raw, /^Subject: New voicemail from unknown \(0:\d\d\)$/m);

  const boundary = /boundary="?([^";\n]+)"?/.exec(raw)?.[1];
  assert.ok(boundary, 'multipart email');
  const part = raw.split(`--${boundary}`).find((p) => /filename="?voicemail-[\d-]+\.wav/.test(p));
  assert.ok(part, 'wav attachment');
  const wav = Buffer.from(part.split(/\n\n/).slice(1).join('').replace(/\s+/g, ''), 'base64');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(20), 1, 'PCM');
  assert.equal(wav.readUInt16LE(22), 1, 'mono');
  assert.equal(wav.readUInt32LE(24), 8000, '8 kHz');
  const seconds = (wav.length - 44) / 16000;
  assert.ok(seconds >= 2, `audio is ${seconds.toFixed(1)} s`);
  console.log(`attachment: PCM 8 kHz mono, ${seconds.toFixed(1)} s`);
  console.log('M4-T2 (voicemail email): PASS');
} catch (e) {
  console.log(`FAIL: ${e.message}`);
  console.log(spawnSync('docker', ['logs', '--tail', '40', AST], { encoding: 'utf8' }).stdout);
  process.exitCode = 1;
} finally {
  server.close();
}
