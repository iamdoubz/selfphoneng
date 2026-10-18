// SPDX-License-Identifier: AGPL-3.0-or-later
// M4-T3 acceptance in a browser: as a normal user, marking a voicemail read (by playing it) and
// deleting one turn the phone's message-waiting light off within 5 s, and a greeting recorded in
// the browser (fake microphone) is what callers hear.
// Runs on the m2-live setup with a voicemail dir, like m4-t2.mjs (after m1-t4.mjs). The "phone" is
// baresip with its mwi module, registered as the new user's extension 160.
// Usage: node scripts/e2e/m4-t3.mjs <baseUrl> <adminEmail> <adminPassword> <vmDir> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './cdp.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const PHONE = 'sp-live-phone160';
const EXT = '160';
const USER = { email: 'mo@example.com', password: 'mo-new-password-123' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...a) => {
  const r = spawnSync('docker', a, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const cli = (cmd) => docker('exec', AST, 'asterisk', '-rx', cmd).out;
const [base, email, pw, vmDir, shotsDir] = process.argv.slice(2);

const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-requested-with': 'selfphoneng' },
  body: JSON.stringify({ email, password: pw }),
});
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

const created = await api('POST', '/api/users', { email: USER.email, displayName: 'Mo Lee' });
const ext = await api('POST', '/api/extensions', {
  number: EXT,
  name: 'Mo Lee',
  userId: created.user.id,
});
const creds = await api('GET', `/api/extensions/${ext.id}/sip-credentials`);

// The desk phone: subscribes to MWI and prints every NOTIFY body.
const dir = mkdtempSync(join(tmpdir(), 'sp-phone160-'));
mkdirSync(join(dir, 'p'));
writeFileSync(
  join(dir, 'p', 'config'),
  'sip_listen 0.0.0.0:5074\nmodule_path /usr/lib/baresip/modules\nmodule g711.so\nmodule aufile.so\nmodule menu.so\nmodule account.so\nmodule mwi.so\naudio_player aufile,/dev/null\naudio_alert aufile,/dev/null\n',
);
writeFileSync(
  join(dir, 'p', 'accounts'),
  `<sip:${EXT}@${AST};transport=udp>;auth_pass=${creds.password};answermode=manual;audio_codecs=PCMU;mwi=yes\n`,
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
const mwi = () => {
  const all = existsSync(join(dir, 'p', 'log'))
    ? readFileSync(join(dir, 'p', 'log'), 'utf8').match(/Messages-Waiting:\s*\w+/gi)
    : null;
  return all?.at(-1)?.split(/:\s*/)[1]?.toLowerCase() ?? null;
};
const waitMwi = async (want, ms, what) => {
  const end = Date.now() + ms;
  while (mwi() !== want && Date.now() < end) await sleep(100);
  assert.equal(mwi(), want, what);
};
/** A Local channel leaves a message: waits out the ~12 s greeting, then "speaks". */
const leaveMessage = () =>
  cli(
    `channel originate Local/${EXT}@sp-vm-direct application Playback silence/10&silence/5&tt-weasels`,
  );

const p = await launch({
  shotsDir,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
try {
  for (
    let i = 0;
    i < 180 && !new RegExp(`${EXT}/sip:.*Avail`).test(cli('pjsip show contacts'));
    i++
  )
    await sleep(1000);
  await waitMwi('no', 10_000, 'phone subscribed to MWI, light off');
  console.log(`phone ${EXT} registered, MWI off`);

  leaveMessage();
  await waitMwi('yes', 60_000, 'MWI on after a message');
  console.log('message left, MWI on');

  // Sign in as the user (first login: forced password change), open Voicemail.
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', USER.email);
  await p.fill('Password', created.temporaryPassword);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/change-password'`, 'forced password change');
  await p.fill('Current password', created.temporaryPassword);
  await p.fill('New password', USER.password);
  await p.fill('Repeat new password', USER.password);
  await p.click('Change password');
  await p.waitFor(`location.pathname === '/me'`, 'my phone home');
  await p.waitFor(`document.body.innerText.includes('New voicemails')`);
  await p.waitFor(`document.body.innerText.includes('Open voicemail')`, 'new voicemail on home');
  await p.shot('m4-t3-01-home');
  await p.click('Voicemail');
  await p.waitFor(`document.querySelectorAll('audio[aria-label^="Voicemail from"]').length === 1`);
  assert.match(await p.text(), /New/);
  await p.shot('m4-t3-02-voicemail');

  // Play → marks read → MWI off within 5 s.
  const t0 = Date.now();
  // play() can stay pending in headless Edge; the play event is what marks it read.
  await p.evaluate(
    `(document.querySelector('audio[aria-label^="Voicemail from"]').play().catch(() => {}), true)`,
  );
  await waitMwi('no', 5000, 'MWI off within 5 s of marking read');
  console.log(`played in the browser: MWI off after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await p.waitFor(`!document.body.innerText.includes('New\\n')`, 'no longer marked new');

  // A second message, deleted in the browser → MWI off within 5 s.
  leaveMessage();
  await waitMwi('yes', 60_000, 'MWI on after the second message');
  await p.evaluate(`dispatchEvent(new Event('focus'))`); // React Query refetches on focus
  await p.waitFor(
    `document.querySelectorAll('audio[aria-label^="Voicemail from"]').length === 2`,
    'second message listed',
    15_000,
  );
  await p.evaluate(
    `[...document.querySelectorAll('li')].find(li => li.innerText.includes('New')).querySelector('button').click()`,
  );
  await p.waitFor(`document.body.innerText.includes('Delete voicemail')`, 'confirm dialog');
  const t1 = Date.now();
  await p.evaluate(
    `[...document.querySelectorAll('dialog button')].find(b => b.textContent === 'Delete').click()`,
  );
  await waitMwi('no', 5000, 'MWI off within 5 s of deleting');
  console.log(`deleted in the browser: MWI off after ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  await p.waitFor(
    `document.querySelectorAll('audio[aria-label^="Voicemail from"]').length === 1`,
    'one message left',
  );

  // Record the "no answer" greeting with the fake microphone (a beep tone).
  await p.evaluate(
    `document.querySelector('[role=group][aria-labelledby=greeting-unavail] button').click()`,
  );
  await p.waitFor(`document.body.innerText.includes('Recording…')`, 'recording');
  await sleep(3000);
  await p.click('Stop and save');
  await p.waitFor(`document.body.innerText.includes('Saved.')`, 'greeting saved', 15_000);
  await p.waitFor(
    `!!document.querySelector('audio[aria-label="When you don\\'t answer greeting"]')`,
  );
  await p.shot('m4-t3-03-greeting');
  const greeting = join(vmDir, 'default', EXT, 'unavail.wav');
  assert.ok(existsSync(greeting), 'unavail.wav in the spool');
  const wav = readFileSync(greeting);
  assert.equal(wav.readUInt32LE(24), 8000, '8 kHz');
  console.log(`greeting recorded in the browser: ${((wav.length - 44) / 16000).toFixed(1)} s wav`);

  // A caller now hears it instead of "the person at extension 160 is unavailable".
  cli(`channel originate Local/${EXT}@sp-vm-direct application Wait 6`);
  let heard = '';
  for (let i = 0; i < 40 && !heard; i++) {
    await sleep(250);
    heard =
      /Playing '([^']*default\/160\/unavail[^']*)'/.exec(
        docker('logs', '--tail', '30', AST).out,
      )?.[1] ?? '';
  }
  assert.ok(heard, 'the caller hears the recorded greeting');
  console.log(`caller heard ${heard}`);
  cli('channel request hangup all');
  assert.deepEqual(p.consoleErrors, [], 'no console errors');
  console.log('M4-T3 (voicemail page, MWI, greeting): PASS');
} catch (e) {
  await p.shot('m4-t3-fail').catch(() => {});
  console.log(`FAIL: ${e.message}`);
  console.log(`phone log tail:\n${docker('exec', PHONE, 'tail', '-n', '15', '/phone/p/log').out}`);
  process.exitCode = 1;
} finally {
  await p.close();
  docker('rm', '-f', PHONE);
}
