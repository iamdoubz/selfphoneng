// SPDX-License-Identifier: AGPL-3.0-or-later
// M6-T3 in a browser + real calls: build digital receptionist 600 in the UI (greeting uploaded from
// the form's SoundPicker, key 1 → 193, key 2 → 194), then a caller presses 1, 2, and a wrong key.
// The caller is a Local channel sending DTMF, so it can "press keys".
// Runs on the m2-live setup with a sounds dir (like m6-t1.mjs), after m1-t4.mjs.
// Usage: node scripts/e2e/m6-t3.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { launch } from './cdp.mjs';
import { startPhones } from './phones.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (cmd) =>
  spawnSync('docker', ['exec', AST, 'asterisk', '-rx', cmd], { encoding: 'utf8' }).stdout ?? '';
const astLog = () => spawnSync('docker', ['logs', AST], { encoding: 'utf8' }).stdout ?? '';
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
const desk = async (number, name) => {
  const e = await api('POST', '/api/extensions', { number, name });
  return (await api('GET', `/api/extensions/${e.id}/sip-credentials`)).password;
};
const phones = startPhones({
  name: 'sp-live-phones-m6t3',
  net: NET,
  ast: AST,
  phones: [
    { ext: '193', password: await desk('193', 'Sal Sales'), answer: 'auto' },
    { ext: '194', password: await desk('194', 'Sam Support'), answer: 'auto', toneHz: 660 },
  ],
});

const waitUntil = async (fn, what, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(200);
  }
  throw new Error(`timeout waiting for: ${what}`);
};
const pick = (label, text) =>
  p.evaluate(`(() => {
    const s = [...document.querySelectorAll('dialog[open] select')].find(s => s.getAttribute('aria-label') === ${JSON.stringify(label)} || s.labels?.[0]?.textContent === ${JSON.stringify(label)});
    if (!s) throw new Error('no select ' + ${JSON.stringify(label)});
    const o = [...s.options].find(o => o.textContent.includes(${JSON.stringify(text)}));
    if (!o) throw new Error('no option ' + ${JSON.stringify(text)});
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, o.value);
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
/** A caller that dials 600 and, after `wait` half-seconds, presses `keys`, then stays on. */
async function callAndPress(keys, wait = 8) {
  const at = astLog().length;
  cli(
    `channel originate Local/600@sp-from-ext application SendDTMF ${'w'.repeat(wait)}${keys}${'w'.repeat(30)}`,
  );
  return () => astLog().slice(at);
}
const hangupAll = async () => {
  cli('channel request hangup all');
  await waitUntil(() => !/(PJSIP|Local)\//.test(cli('core show channels concise')), 'calls ended');
  await sleep(500);
};

const p = await launch({ shotsDir });
try {
  await waitUntil(
    () =>
      ['193', '194'].every((n) => new RegExp(`${n}/sip:.*Avail`).test(cli('pjsip show contacts'))),
    'phones registered',
    180_000,
  );
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`);
  await p.click('Digital receptionist');
  await p.click('Add menu');
  await p.waitFor(`!!document.querySelector('dialog[open]')`);
  await p.waitFor(
    `[...document.querySelectorAll('dialog[open] label')].find(l => l.textContent === 'Number')?.control.value === '600'`,
    'next free number',
  );
  await p.fill('Name', 'Main menu', 'dialog[open]');

  // Greeting: "Upload new" in the SoundPicker (3 s of a 520 Hz tone).
  await p.evaluate(`(() => {
    const rate = 8000, n = rate * 3, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const s = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    s(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); s(8, 'WAVEfmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    s(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin((2 * Math.PI * 520 * i) / rate) * 8000, true);
    const dt = new DataTransfer();
    dt.items.add(new File([buf], 'Main greeting.wav', { type: 'audio/wav' }));
    const input = document.querySelector('input[aria-label="Upload a new sound for Greeting"]');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await p.waitFor(
    `[...document.querySelectorAll('dialog[open] label')].find(l => l.textContent === 'Greeting')?.control.selectedOptions[0]?.textContent === 'Main greeting'`,
    'greeting uploaded and selected',
    20_000,
  );

  for (const [key, who] of [
    ['1', 'Sal Sales'],
    ['2', 'Sam Support'],
  ]) {
    await p.click(`Key ${key}`, 'dialog[open]');
    await p.click(`Use key ${key}`, 'dialog[open]');
    await pick(`Key ${key} goes to: type`, 'Ring a user');
    await pick(`Key ${key} goes to: user`, who);
  }
  await p.waitFor(
    `document.querySelector('dialog[open] [aria-label="Key 1"]').innerText.includes('Sal Sales')`,
    'key 1 summary',
  );
  await p.shot('m6-t3-01-keypad');
  await p.click('Save', 'dialog[open]');
  await p.waitFor(`document.body.innerText.includes('1: Ring Sal Sales (193)')`, 'saved', 10_000);
  await waitUntil(
    () => /Goto\(sp-ivr-/.test(cli('dialplan show 600@sp-local-numbers')),
    'dialplan',
  );
  console.log('menu 600 built in the UI: greeting uploaded, keys 1 and 2');

  const greeting = (await api('GET', '/api/sounds')).items.find((s) => s.name === 'Main greeting');
  let log = await callAndPress('1');
  await waitUntil(() => /Called PJSIP\/193\//.test(log()), 'key 1 rings 193');
  assert.match(log(), new RegExp(`Playing '${greeting.asteriskName}\\.`), 'greeting played');
  console.log('caller heard the greeting, pressed 1 → 193 rang');
  await hangupAll();

  log = await callAndPress('2');
  await waitUntil(() => /Called PJSIP\/194\//.test(log()), 'key 2 rings 194');
  console.log('pressed 2 → 194 rang');
  await hangupAll();

  log = await callAndPress('5');
  await waitUntil(() => /Playing 'pbx-invalid/.test(log()), 'wrong key message');
  await waitUntil(
    () => (log().match(new RegExp(`Playing '${greeting.asteriskName}`, 'g')) ?? []).length >= 2,
    'greeting again',
  );
  console.log('pressed 5 → "not a valid choice", greeting again');
  await hangupAll();

  console.log('M6-T3 (digital receptionist): PASS');
} catch (e) {
  await p.shot('m6-t3-fail').catch(() => {});
  console.log(`FAIL: ${e.message}`);
  console.log(`browser errors: ${JSON.stringify(p.consoleErrors)}`);
  process.exitCode = 1;
} finally {
  await p.close();
  phones.stop();
}
