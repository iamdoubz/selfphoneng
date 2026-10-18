// SPDX-License-Identifier: AGPL-3.0-or-later
// M3-T4 in a browser: dashboard warnings, Settings → Email and Emergency, and the test button
// (email arrives, the notify phone rings, the red banner shows). Nothing dials 911.
// Run after m3-t1..t3 on the m2-live setup. Needs the api started with SMTP reachable at
// 127.0.0.1:2525, which this script provides (a tiny SMTP sink).
// Usage: node scripts/e2e/m3-t4.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './cdp.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const PHONE = 'sp-live-phone101';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...a) => {
  const r = spawnSync('docker', a, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const cli = (cmd) => docker('exec', AST, 'asterisk', '-rx', cmd).out;
const [base, email, pw, shotsDir] = process.argv.slice(2);

/** Just enough SMTP for nodemailer: no auth, no TLS, keeps every message. */
const mails = [];
const smtp = createServer((sock) => {
  let data = false;
  let buf = '';
  let msg = '';
  sock.write('220 sink ESMTP\r\n');
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (data) {
        if (line === '.') {
          data = false;
          mails.push(msg);
          msg = '';
          sock.write('250 ok\r\n');
        } else msg += line + '\n';
      } else if (/^EHLO/i.test(line)) sock.write('250-sink\r\n250 OK\r\n');
      else if (/^DATA/i.test(line)) {
        data = true;
        sock.write('354 go\r\n');
      } else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n');
      else sock.write('250 ok\r\n');
    }
  });
});
await new Promise((r) => smtp.listen(2525, '127.0.0.1', r));

const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-requested-with': 'selfphoneng' },
  body: JSON.stringify({ email, password: pw }),
});
const cookie = login.headers.get('set-cookie').split(';')[0];
const get = async (path) => (await fetch(`${base}${path}`, { headers: { cookie } })).json();

// A softphone registered as 101 (Dan, from m3-t2), to be the "ring these phones" target.
const dan = (await get('/api/extensions')).items.find((e) => e.number === '101');
const creds = await get(`/api/extensions/${dan.id}/sip-credentials`);
const dir = mkdtempSync(join(tmpdir(), 'sp-phone101-'));
mkdirSync(join(dir, 'p'));
writeFileSync(
  join(dir, 'p', 'config'),
  'sip_listen 0.0.0.0:5070\nmodule_path /usr/lib/baresip/modules\nmodule g711.so\nmodule ausine.so\nmodule aufile.so\nmodule menu.so\nmodule account.so\naudio_source ausine,440\nausrc_srate 48000\nauplay_srate 48000\naudio_player aufile,/phone/p/heard.wav\naudio_alert aufile,/dev/null\n',
);
writeFileSync(
  join(dir, 'p', 'accounts'),
  `<sip:101@${AST};transport=udp>;auth_pass=${creds.password};answermode=auto;audio_codecs=PCMU\n`,
);
docker('rm', '-f', PHONE);
assert.ok(
  docker(
    'run',
    '-d',
    '--rm',
    '--name',
    PHONE,
    '--network',
    NET,
    '-v',
    `${dir}:/phone`,
    'debian:trixie-slim',
    'sh',
    '-c',
    'apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends baresip-core >/dev/null 2>&1 && baresip -f /phone/p > /phone/p/log 2>&1',
  ).ok,
);

const p = await launch({ shotsDir });
try {
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`);
  await p.waitFor(
    `document.body.innerText.includes('No emergency (E911) caller ID is set') && document.body.innerText.includes('Email is not set up')`,
    'dashboard warnings',
  );
  await p.shot('m3-t4-01-warnings');
  console.log('dashboard: E911 caller ID and email warnings');

  // Email
  await p.click('Settings');
  await p.waitFor(`document.body.innerText.includes('SMTP server')`);
  await p.fill('SMTP server', '127.0.0.1');
  await p.fill('Port', '2525');
  await p.fill('From', 'Phone system <pbx@example.com>');
  await p.click('Save');
  await p.waitFor(`document.body.innerText.includes('Saved.')`, 'smtp saved');
  await p.fill('Send a test email to', 'admin@example.com');
  await p.click('Send test');
  await p.waitFor(`document.body.innerText.includes('Sent. Check the inbox')`, 'test email', 15000);
  assert.ok(
    mails.some((m) => m.includes('Subject: SelfPhoneNG test email')),
    'test email arrived',
  );
  console.log('email: test message received by the SMTP sink');

  // Emergency
  await p.click('Emergency');
  await p.waitFor(`document.body.innerText.includes('Default emergency caller ID')`);
  const did = (await get('/api/dids')).items[0];
  await p.waitFor(`!!document.querySelector('option[value="${did.id}"]')`, 'phone numbers loaded');
  await p.fill('Default emergency caller ID', did.id);
  await p.fill('Email these people', 'security@example.com');
  await p.evaluate(
    `[...document.querySelectorAll('label')].find(l => l.textContent.includes('101 Dan Doe')).querySelector('input').click(), true`,
  );
  await p.click('Save');
  await p.waitFor(`document.body.innerText.includes('Saved.')`, 'emergency saved');

  for (let i = 0; i < 120 && !/101\/sip:.*Avail/.test(cli('pjsip show contacts')); i++)
    await sleep(1000);
  assert.match(cli('pjsip show contacts'), /101\/sip:.*Avail/, 'phone 101 registered');
  const before = mails.length;
  await p.click('Test notifications');
  await p.waitFor(`document.body.innerText.includes('Rang 101: ok')`, 'test result', 20000);
  await p.waitFor(
    `document.body.innerText.includes('TEST of the 911 alerts (Administrator)')`,
    'red banner',
  );
  let rang = '';
  for (let i = 0; i < 30 && !/sp-emergency-alert/.test(rang); i++) {
    await sleep(300);
    rang = cli('core show channels concise');
  }
  assert.match(rang, /^PJSIP\/101-.*sp-emergency-alert/m, '101 answered the alert ring-out');
  for (let i = 0; i < 30 && mails.length === before; i++) await sleep(200);
  const alert = mails.slice(before).find((m) => /Subject: TEST EMERGENCY: 911 dialed/.test(m));
  assert.ok(alert, 'alert email arrived');
  assert.ok(
    !/to=911|Dial\(PJSIP\/911/.test(cli('core show channels concise')),
    'nothing dialed 911',
  );
  await p.shot('m3-t4-02-test-notifications');
  console.log('test button: email + ring-out on 101 + red banner, nothing dialed');

  // The dashboard now asks to confirm the E911 address of that number.
  await p.click('Dismiss');
  await p.click('Dashboard');
  await p.waitFor(
    `document.body.innerText.includes('Confirm the emergency caller ID number has an E911 address')`,
    'address warning',
  );
  assert.ok(!(await p.evaluate('document.body.innerText')).includes('Email is not set up'));
  await p.shot('m3-t4-03-dashboard');
  assert.deepEqual(p.consoleErrors, [], 'no console errors');
  console.log('M3-T4 (UI): PASS');
} catch (e) {
  await p.shot('m3-t4-FAILED').catch(() => {});
  console.error('FAIL:', e.message, '\nconsole:', p.consoleErrors);
  process.exitCode = 1;
} finally {
  await p.close();
  docker('rm', '-f', PHONE);
  smtp.close();
}
