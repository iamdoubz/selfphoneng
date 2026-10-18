// SPDX-License-Identifier: AGPL-3.0-or-later
// M7-T3 acceptance: "a recorded call is playable from history". In the UI: Settings → Recording
// picks the notice, Phone numbers → "Record every call". Then a caller (AMI Originate into the
// trunk entry, with a caller ID) reaches 240 (auto-answer): the notice plays, MixMonitor records,
// the call shows in Call history with a working player, and on the Recordings page.
// Runs on m2-live with sounds and recordings dirs (m2-live.mjs up <conf> <vm> <sounds> <recs>),
// api with SOUNDS_DIR and RECORDINGS_DIR, after m1-t4.mjs.
// Usage: node scripts/e2e/m7-t3.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { originate } from './ami.mjs';
import { launch } from './cdp.mjs';
import { startPhones } from './phones.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const DID = '13125558888';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (cmd) =>
  spawnSync('docker', ['exec', AST, 'asterisk', '-rx', cmd], { encoding: 'utf8' }).stdout ?? '';
// eslint-disable-next-line no-control-regex -- strips Asterisk's log colors
const ANSI = /\x1b\[[0-9;]*m/g;
const astLog = () =>
  (spawnSync('docker', ['logs', AST], { encoding: 'utf8' }).stdout ?? '').replace(ANSI, '');
const [base, email, pw, shotsDir] = process.argv.slice(2);

const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-requested-with': 'selfphoneng' },
  body: JSON.stringify({ email, password: pw }),
});
const cookie = login.headers
  .getSetCookie()
  .map((c) => c.split(';')[0])
  .join('; ');
const api = async (method, url, body, raw) => {
  const r = await fetch(`${base}${url}`, {
    method,
    headers: {
      'content-type': raw ? 'audio/wav' : 'application/json',
      'x-requested-with': 'selfphoneng',
      cookie,
    },
    body: raw ?? (body && JSON.stringify(body)),
  });
  const json = await r.json();
  assert.ok(r.ok, `${method} ${url}: ${r.status} ${JSON.stringify(json)}`);
  return json;
};
const tone = (secs, hz) => {
  const n = 8000 * secs;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / 8000) * 8000), 44 + i * 2);
  return b;
};

const notice = await api('POST', '/api/sounds?name=Recording%20notice', undefined, tone(2, 700));
const desk = await api('POST', '/api/extensions', { number: '240', name: 'Rita Recorded' });
const pass = (await api('GET', `/api/extensions/${desk.id}/sip-credentials`)).password;
const trunk = await api('POST', '/api/trunks', {
  name: 'M7 recording',
  serverHost: '127.0.0.1',
  username: 'm7rec',
  password: 'unused-pw',
});
await api('POST', '/api/dids', {
  number: DID,
  trunkId: trunk.id,
  label: 'Recorded line',
  destination: { type: 'user', id: desk.id },
});
const phones = startPhones({
  name: 'sp-live-phones-m7t3',
  net: NET,
  ast: AST,
  phones: [{ ext: '240', password: pass, answer: 'auto' }],
});
const waitUntil = async (fn, what, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(300);
  }
  throw new Error(`timeout waiting for: ${what}`);
};
const pickInDialog = (label, text) =>
  p.evaluate(`(() => {
    const s = [...document.querySelectorAll('select')].find(s => s.labels?.[0]?.textContent === ${JSON.stringify(label)});
    const o = [...s.options].find(o => o.textContent.includes(${JSON.stringify(text)}));
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, o.value);
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);

const p = await launch({ shotsDir });
try {
  await waitUntil(() => /240\/sip:.*Avail/.test(cli('pjsip show contacts')), 'phone', 180_000);
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`);

  // Settings → Recording: the notice.
  await p.goto(`${base}/admin/settings/recording`);
  await p.waitFor(`document.body.innerText.includes('Recording consent')`);
  await pickInDialog('Notice played before a recorded call', 'Recording notice');
  await p.click('Save');
  await p.waitFor(`document.body.innerText.includes('Saved.')`);
  // Phone numbers → Record every call.
  await p.click('Phone numbers');
  await p.waitFor(`document.body.innerText.includes('Recorded line')`);
  await p.evaluate(
    `[...document.querySelectorAll('li')].find(li => li.innerText.includes('Recorded line')).querySelector('button').click(), true`,
  );
  await p.waitFor(`!!document.querySelector('dialog[open]')`);
  await p.evaluate(
    `(() => { const c = [...document.querySelectorAll('dialog[open] label')].find(l => l.textContent.includes('Record every call')).querySelector('input'); c.click(); return c.checked; })()`,
  );
  await p.click('Save', 'dialog[open]');
  await p.waitFor(`!document.querySelector('dialog[open]')`, 'saved');
  await waitUntil(
    () => cli(`dialplan show ${DID}@sp-inbound`).includes('sp-sub-record'),
    'recording in the dialplan',
  );
  console.log('UI: recording notice set, the phone number records');

  // A caller from outside.
  const at = astLog().length;
  await originate({
    Channel: `Local/${DID}@sp-from-trunk-${trunk.id}`,
    CallerID: '"Outside" <3125550777>',
    Application: 'Wait',
    Data: '20',
  });
  await waitUntil(() => /Called PJSIP\/240\//.test(astLog().slice(at)), '240 rings', 20_000);
  const log = astLog().slice(at);
  assert.match(log, new RegExp(`Playing '${notice.asteriskName}\\.`), 'notice before the call');
  assert.match(log, /MixMonitor\(/, 'recording started');
  await sleep(6000);
  cli('channel request hangup all');
  // Found by the DID: the Originate's own Local;1 leg carries 240's name as connected-line
  // caller ID and can sort first, so "from" isn't the outside caller in this synthetic setup.
  await waitUntil(
    async () => (await api('GET', `/api/calls?q=5558888`)).items[0]?.recordingId,
    'call with its recording in history',
  );
  const call = (await api('GET', `/api/calls?q=5558888`)).items[0];
  console.log(`call in history (${call.status}, ${call.talkSeconds} s) with a recording`);

  // Call history: expand, the player's audio is a real recording.
  await p.click('Call history');
  await p.waitFor(
    `[...document.querySelectorAll('ul[aria-label=Calls] > li')].some(li => li.innerText.includes('(312) 555-8888'))`,
  );
  await p.evaluate(
    `[...document.querySelectorAll('ul[aria-label=Calls] > li')].find(li => li.innerText.includes('(312) 555-8888')).querySelector('button[aria-expanded]').click(), true`,
  );
  await p.waitFor(`!!document.querySelector('audio[aria-label="Play the recording"]')`, 'player');
  const audio = await p.evaluate(`(async () => {
    const r = await fetch(document.querySelector('audio[aria-label="Play the recording"]').src);
    const b = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, type: r.headers.get('content-type'), riff: String.fromCharCode(...b.slice(0, 4)), bytes: b.length };
  })()`);
  assert.equal(audio.status, 200);
  assert.equal(audio.riff, 'RIFF');
  assert.ok(audio.bytes > 8000 * 2 * 3, `recording is ${audio.bytes} bytes`);
  await p.shot('m7-t3-01-history');
  console.log(`playable from history: ${audio.type}, ${audio.bytes} bytes`);

  await p.click('Recordings');
  await p.waitFor(`document.querySelectorAll('ul[aria-label=Recordings] > li').length >= 1`);
  await p.shot('m7-t3-02-recordings');
  console.log('listed on the Recordings page');
  console.log('M7-T3 (recording): PASS');
} catch (e) {
  await p.shot('m7-t3-fail').catch(() => {});
  console.log(`FAIL: ${e.message}`);
  console.log(`browser errors: ${JSON.stringify(p.consoleErrors)}`);
  process.exitCode = 1;
} finally {
  await p.close();
  phones.stop();
}
