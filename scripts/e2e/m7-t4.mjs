// SPDX-License-Identifier: AGPL-3.0-or-later
// M7-T4 acceptance: "the live list matches `core show channels` during 3 concurrent calls". Seven
// auto-answer phones (260-266), three calls between them; the dashboard's "Calls now" list shows
// exactly the channels Asterisk has. Then an admin hangs one up and transfers another to 266.
// Runs on m2-live, after m1-t4.mjs.
// Usage: node scripts/e2e/m7-t4.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { launch } from './cdp.mjs';
import { startPhones } from './phones.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (cmd) =>
  spawnSync('docker', ['exec', AST, 'asterisk', '-rx', cmd], { encoding: 'utf8' }).stdout ?? '';
/** Channel names from `core show channels concise`. */
const astChannels = () =>
  cli('core show channels concise')
    .split('\n')
    .map((l) => l.split('!')[0].trim())
    .filter(Boolean)
    .sort();
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
const waitUntil = async (fn, what, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(300);
  }
  throw new Error(`timeout waiting for: ${what}`);
};

const EXTS = ['260', '261', '262', '263', '264', '265', '266'];
const phoneList = [];
for (const ext of EXTS) {
  const e = await api('POST', '/api/extensions', { number: ext, name: `Live ${ext}` });
  const pass = (await api('GET', `/api/extensions/${e.id}/sip-credentials`)).password;
  phoneList.push({ ext, password: pass, answer: 'auto' });
}
const phones = startPhones({ name: 'sp-live-phones-m7t4', net: NET, ast: AST, phones: phoneList });
/** The dashboard's calls: linkedid → channel names. */
const uiCalls = () =>
  p.evaluate(
    `Object.fromEntries([...document.querySelectorAll('ul[aria-label="Calls now"] > li')].map(li => [li.dataset.linkedid, li.querySelector('[data-channels]').textContent.split(' ')]))`,
  );
const uiChannels = async () =>
  Object.values(await uiCalls())
    .flat()
    .sort();
const callWith = async (ext) =>
  Object.entries(await uiCalls()).find(([, ch]) =>
    ch.some((c) => c.startsWith(`PJSIP/${ext}-`)),
  )?.[0];

const p = await launch({ shotsDir });
try {
  await waitUntil(
    () => EXTS.every((e) => new RegExp(`${e}/sip:.*Avail`).test(cli('pjsip show contacts'))),
    'phones',
    180_000,
  );
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`);
  await p.waitFor(`document.body.innerText.includes('No calls right now.')`);

  // Three calls at once: 261 → 260, 263 → 262, 265 → 264.
  for (const [from, to] of [
    ['261', '260'],
    ['263', '262'],
    ['265', '264'],
  ])
    cli(`channel originate PJSIP/${from} extension ${to}@sp-from-ext`);
  await waitUntil(
    () => astChannels().length === 6 && cli('core show channels').includes('6 active channels'),
    'six channels in Asterisk',
  );
  await p.waitFor(
    `[...document.querySelectorAll('ul[aria-label="Calls now"] > li')].filter(li => li.innerText.includes('Talking')).length === 3`,
    'three calls talking',
  );
  assert.deepEqual(await uiChannels(), astChannels(), 'dashboard matches core show channels');
  await p.shot('m7-t4-01-three-calls');
  console.log(`3 calls: dashboard matches core show channels (${astChannels().length} channels)`);

  // Hang up 261 → 260 from the dashboard.
  const first = await callWith('261');
  await p.click('Hang up', `li[data-linkedid="${first}"]`);
  await p.waitFor(`!!document.querySelector('dialog[open]')`);
  await p.click('Hang up', 'dialog[open]');
  await waitUntil(() => !astChannels().some((c) => /^PJSIP\/26[01]-/.test(c)), '261 hung up');
  await p.waitFor(`document.querySelectorAll('ul[aria-label="Calls now"] > li').length === 2`);
  assert.deepEqual(await uiChannels(), astChannels(), 'after the hang-up');
  console.log('hang up: the call is gone from Asterisk and the dashboard');

  // Transfer 263 (the caller) to 266: 262 drops, 266 rings and answers.
  const second = await callWith('263');
  await p.fill('Transfer to', '266', `li[data-linkedid="${second}"]`);
  await p.click('Transfer', `li[data-linkedid="${second}"]`);
  await waitUntil(
    () =>
      astChannels().some((c) => c.startsWith('PJSIP/266-')) &&
      !astChannels().some((c) => c.startsWith('PJSIP/262-')),
    '263 talking to 266',
  );
  await p.waitFor(
    `[...document.querySelectorAll('ul[aria-label="Calls now"] > li')].some(li => li.innerText.includes('PJSIP/266-') && li.innerText.includes('Talking'))`,
    'transferred call talking',
  );
  await sleep(1000);
  assert.deepEqual(await uiChannels(), astChannels(), 'after the transfer');
  await p.shot('m7-t4-02-transferred');
  console.log('transfer: 263 now talks to 266, dashboard matches');

  cli('channel request hangup all');
  await p.waitFor(`document.body.innerText.includes('No calls right now.')`, 'list empties');
  console.log('M7-T4 (live calls): PASS');
} catch (e) {
  await p.shot('m7-t4-fail').catch(() => {});
  console.log(`FAIL: ${e.message}`);
  console.log(`browser errors: ${JSON.stringify(p.consoleErrors)}`);
  process.exitCode = 1;
} finally {
  await p.close();
  phones.stop();
}
