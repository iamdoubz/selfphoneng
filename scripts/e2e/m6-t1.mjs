// SPDX-License-Identifier: AGPL-3.0-or-later
// M6-T1 in a browser: drop an audio file on Sounds & music, upload it, play it, rename it, see
// Asterisk play custom/<id>, and delete it (refused while it's the recording notice).
// Runs on the m2-live setup with a sounds dir (m2-live.mjs up <confDir> <vmDir> <soundsDir>) and
// the api started with SOUNDS_DIR=<soundsDir>, after m1-t4.mjs.
// Usage: node scripts/e2e/m6-t1.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { launch } from './cdp.mjs';

const AST = 'sp-live-ast';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...a) => spawnSync('docker', a, { encoding: 'utf8' }).stdout ?? '';
const cli = (cmd) => docker('exec', AST, 'asterisk', '-rx', cmd);
const [base, email, pw, shotsDir] = process.argv.slice(2);

const p = await launch({ shotsDir });
try {
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`);
  await p.click('Sounds & music');
  await p.waitFor(`document.body.innerText.includes('No sounds yet')`, 'empty list');

  // A 2 s 440 Hz tone as a wav file, dropped on the upload area like a user would.
  await p.evaluate(`(() => {
    const rate = 8000, n = rate * 2, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const s = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    s(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); s(8, 'WAVEfmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    s(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin((2 * Math.PI * 440 * i) / rate) * 8000, true);
    const dt = new DataTransfer();
    dt.items.add(new File([buf], 'main_greeting.wav', { type: 'audio/wav' }));
    const form = document.querySelector('form[aria-label="Upload a sound"]');
    form.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await p.waitFor(`document.body.innerText.includes('Selected: main_greeting.wav')`, 'file picked');
  assert.equal(
    await p.evaluate(
      `[...document.querySelectorAll('label')].find(l => l.textContent === 'Name').control.value`,
    ),
    'main greeting',
    'name suggested from the file name',
  );
  await p.fill('Name', 'Main greeting');
  await p.click('Upload');
  await p.waitFor(
    `!!document.querySelector('audio[aria-label="Play Main greeting"]')`,
    'uploaded',
    15_000,
  );
  assert.match(await p.text(), /Main greeting 0:02/);
  await p.shot('m6-t1-01-uploaded');
  console.log('uploaded by drag and drop: "Main greeting" 0:02');

  const sound = (await p.evaluate(`fetch('/api/sounds').then(r => r.json())`)).items[0];
  const status = await p.evaluate(`fetch('/api/sounds/${sound.id}/audio').then(r => r.status)`);
  assert.equal(status, 200, 'audio plays');

  // Asterisk plays it: a Local channel answers with Playback(custom/<id>).
  const before = docker('logs', AST).length;
  cli(`channel originate Local/99@sp-vm-direct application Playback ${sound.asteriskName}`);
  let played = '';
  for (let i = 0; i < 20 && !played; i++) {
    await sleep(250);
    played = docker('logs', AST).slice(before);
  }
  assert.match(
    played,
    new RegExp(`Playing '${sound.asteriskName}\\.`),
    'Asterisk played custom/<id>',
  );
  assert.doesNotMatch(played, /Unable to open|not found/i);
  console.log(`Asterisk played ${sound.asteriskName}`);

  await p.click('Rename');
  await p.waitFor(`!!document.querySelector('dialog[open]')`);
  await p.fill('Name', 'Welcome', 'dialog[open]');
  await p.evaluate(
    `[...document.querySelectorAll('dialog[open] button')].find(b => b.textContent === 'Save').click(), true`,
  );
  await p.waitFor(`!!document.querySelector('audio[aria-label="Play Welcome"]')`, 'renamed');
  console.log('renamed to "Welcome"');

  // In use as the recording notice → the delete is refused with the reason.
  await p.evaluate(
    `fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-requested-with': 'selfphoneng' }, body: JSON.stringify({ 'recordings.announcementSoundId': '${sound.id}' }) }).then(r => r.status)`,
  );
  await p.click('Delete');
  await p.evaluate(
    `[...document.querySelectorAll('dialog[open] button')].find(b => b.textContent === 'Delete').click(), true`,
  );
  await p.waitFor(
    `document.body.innerText.includes('still used by the call recording notice')`,
    'refused',
  );
  await p.shot('m6-t1-02-in-use');
  console.log('delete refused while it is the recording notice');
  await p.evaluate(
    `fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-requested-with': 'selfphoneng' }, body: JSON.stringify({ 'recordings.announcementSoundId': null }) }).then(r => r.status)`,
  );
  await p.evaluate(
    `[...document.querySelectorAll('dialog[open] button')].find(b => b.textContent === 'Delete').click(), true`,
  );
  await p.waitFor(`document.body.innerText.includes('No sounds yet')`, 'deleted');
  console.log('deleted');
  assert.deepEqual(
    p.consoleErrors.filter((e) => !/409/.test(e)),
    [],
    'no console errors',
  );
  console.log('M6-T1 (sounds): PASS');
} catch (e) {
  await p.shot('m6-t1-fail').catch(() => {});
  console.log(`FAIL: ${e.message}`);
  process.exitCode = 1;
} finally {
  await p.close();
}
