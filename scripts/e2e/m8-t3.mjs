// SPDX-License-Identifier: AGPL-3.0-or-later
// M8-T3 with real calls: room 800 built in the UI (PIN 4826, admin PIN 917355, 3 people at most,
// recorded). Callers are Local channels typing the PIN with SendDTMF: a wrong PIN is refused and
// asked again, the admin PIN joins as admin (marked), the room fills at 3 and a 4th caller is
// turned away, and each recorded caller shows up in Recordings. Room 801 has no PIN: two desk
// phones (300, 301) dial it and are in at once.
// Runs on m2-live with a recordings dir, after m1-t4.mjs.
// Usage: node scripts/e2e/m8-t3.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { launch } from './cdp.mjs';
import { startPhones } from './phones.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (cmd) =>
  spawnSync('docker', ['exec', AST, 'asterisk', '-rx', cmd], { encoding: 'utf8' }).stdout ?? '';
const astLog = () =>
  // eslint-disable-next-line no-control-regex -- Asterisk colors its log
  spawnSync('docker', ['logs', AST], { encoding: 'utf8' }).stdout.replace(/\x1b\[[0-9;]*m/g, '');
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
    const v = await fn();
    if (v) return v;
    await sleep(300);
  }
  throw new Error(`timeout waiting for: ${what}`);
};
/** `confbridge list <room>` participant lines (channel, flags). */
const members = (room) =>
  cli(`confbridge list ${room}`)
    .split('\n')
    .filter((l) => /^(Local|PJSIP)\//.test(l))
    .map((l) => ({ channel: l.split(/\s+/)[0], flags: l.split(/\s+/)[1] ?? '' }));
/** A caller dialing `room` that types `keys` (w = half a second) and then stays a minute. */
const caller = (room, keys) =>
  cli(`channel originate Local/${room}@sp-from-ext application SendDTMF ${keys}${'w'.repeat(120)}`);

const phoneList = [];
for (const [ext, name] of [
  ['300', 'Cora Conf'],
  ['301', 'Cy Conf'],
]) {
  const e = await api('POST', '/api/extensions', { number: ext, name });
  const pass = (await api('GET', `/api/extensions/${e.id}/sip-credentials`)).password;
  phoneList.push({ ext, password: pass, answer: 'auto' });
}
const phones = startPhones({ name: 'sp-live-phones-m8t3', net: NET, ast: AST, phones: phoneList });

const p = await launch({ shotsDir });
const check = (text) =>
  p.evaluate(`(() => {
    const l = [...document.querySelectorAll('dialog[open] label')].find(l => l.textContent.includes(${JSON.stringify(text)}));
    const box = l.querySelector('input[type=checkbox]');
    if (!box.checked) box.click();
    return true;
  })()`);
try {
  await waitUntil(
    () =>
      ['300', '301'].every((e) => new RegExp(`${e}/sip:.*Avail`).test(cli('pjsip show contacts'))),
    'phones',
    180_000,
  );
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`);

  // Room 800 in the UI.
  await p.click('Conferences');
  await p.click('Add room');
  await p.waitFor(`!!document.querySelector('dialog[open]')`);
  await p.waitFor(
    `[...document.querySelectorAll('dialog[open] label')].find(l => l.textContent === 'Number')?.control.value === '800'`,
    'next free room number suggested',
  );
  await p.fill('Name', 'Board', 'dialog[open]');
  await p.fill('PIN', '4826', 'dialog[open]');
  await p.fill('Most people at once', '3', 'dialog[open]');
  await check('Record');
  // First a mistake the form catches (admin PIN = PIN), then the real one.
  await p.fill('Admin PIN', '4826', 'dialog[open]');
  await p.click('Save', 'dialog[open]');
  await p.waitFor(
    `document.querySelector('dialog[open]')?.innerText.includes('different')`,
    'same PIN refused',
  );
  await p.fill('Admin PIN', '917355', 'dialog[open]');
  await p.click('Save', 'dialog[open]');
  await p.waitFor(
    `document.body.innerText.includes('PIN 4826 · admin PIN 917355 · up to 3 · recorded')`,
    'saved',
  );
  await waitUntil(
    () => /sp-conf-/.test(cli('dialplan show 800@sp-local-numbers')),
    'dialplan has 800',
  );
  await p.shot('m8-t3-01-rooms');
  console.log('room 800 built in the UI (the form refused an admin PIN equal to the PIN)');

  // A wrong PIN is refused and asked again; then the right one gets in.
  let at = astLog().length;
  caller('800', 'wwwwww1111#wwwwwwwwww4826#');
  await waitUntil(() => /Playing 'conf-invalidpin/.test(astLog().slice(at)), 'wrong PIN refused');
  await waitUntil(() => members('800').length === 1, 'first caller in', 20_000);
  console.log('wrong PIN: conf-invalidpin and asked again; the right PIN joins');

  // The admin PIN joins as admin (A) and marked (M).
  caller('800', 'wwwwww917355#');
  await waitUntil(() => members('800').length === 2, 'admin in', 20_000);
  const admin = members('800').find((m) => /A/.test(m.flags));
  assert.ok(admin && /M/.test(admin.flags), `flags: ${JSON.stringify(members('800'))}`);
  console.log(`admin PIN: joined with flags ${admin.flags}`);

  // The room holds 3: a 4th caller is turned away.
  caller('800', 'wwwwww4826#');
  await waitUntil(() => members('800').length === 3, 'third in', 20_000);
  caller('800', 'wwwwww4826#');
  await sleep(10_000); // dialed, typed the PIN (3 s) and would be in by now
  assert.equal(
    members('800').length,
    3,
    `room should stay at 3: ${JSON.stringify(members('800'))}`,
  );
  console.log('max 3: a 4th caller with the right PIN was turned away');

  // Room 801 without a PIN: two desk phones dial it and are in.
  await api('POST', '/api/conferences', {
    number: '801',
    name: 'Huddle',
    pin: null,
    adminPin: null,
  });
  await waitUntil(
    () => /sp-conf-/.test(cli('dialplan show 801@sp-local-numbers')),
    'dialplan has 801',
  );
  cli('channel originate PJSIP/300 extension 801@sp-from-ext');
  cli('channel originate PJSIP/301 extension 801@sp-from-ext');
  await waitUntil(
    () =>
      members('801')
        .map((m) => m.channel.slice(0, 10))
        .sort()
        .join() === 'PJSIP/300-,PJSIP/301-',
    'both phones in 801',
    20_000,
  );
  console.log('room 801 (no PIN): desk phones 300 and 301 are in');

  // Everyone leaves; the three recorded callers of 800 are in Recordings.
  cli('channel request hangup all');
  const recs = await waitUntil(
    async () => {
      const r = await api('GET', '/api/recordings');
      return r.items.length >= 3 && r;
    },
    '3 recordings',
    40_000,
  );
  // 3 callers in the room + the one turned away (recording starts as ConfBridge is tried)
  console.log(`recordings: ${recs.items.length}, one per caller who dialed 800 with the PIN`);
  await p.goto(`${base}/admin/recordings`);
  await p.waitFor(
    `document.body.innerText.includes('800')`,
    'recordings page shows room 800 calls',
  );
  await p.shot('m8-t3-02-recordings');
  console.log('M8-T3 (conferences): PASS');
} catch (e) {
  await p.shot('m8-t3-fail').catch(() => {});
  console.log(`FAIL: ${e.message}`);
  console.log(`800: ${cli('confbridge list 800')}`);
  console.log(`browser errors: ${JSON.stringify(p.consoleErrors)}`);
  process.exitCode = 1;
} finally {
  cli('channel request hangup all');
  await p.close();
  phones.stop();
}
