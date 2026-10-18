// SPDX-License-Identifier: AGPL-3.0-or-later
// M5-T3 acceptance: presence dots change in < 1 s after Asterisk's state changes, and
// click-to-call from People rings the user's desk phone first, then the other person.
// Run after m5-t2.mjs (extensions 172/173 and user web@example.com exist).
// Usage: node scripts/e2e/m5-t3.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { launch } from './cdp.mjs';
import { startPhones } from './phones.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const WEB = { email: 'web@example.com', password: 'web-new-password-123' };
const CC = { email: 'cc@example.com', password: 'cc-new-password-123' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (cmd) =>
  spawnSync('docker', ['exec', AST, 'asterisk', '-rx', cmd], { encoding: 'utf8' }).stdout ?? '';
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
const exts = (await api('GET', '/api/extensions')).items;
const secret = async (id) => (await api('GET', `/api/extensions/${id}/sip-credentials`)).password;
const cc = await api('POST', '/api/users', { email: CC.email, displayName: 'Cam Clicker' });
const ccExt = await api('POST', '/api/extensions', {
  number: '174',
  name: 'Cam Clicker',
  userId: cc.user.id,
});
const byNumber = (n) => exts.find((e) => e.number === n);
const phones = startPhones({
  name: 'sp-live-phones-m5t3',
  net: NET,
  ast: AST,
  phones: [
    { ext: '172', password: await secret(byNumber('172').id), answer: 'auto' },
    { ext: '173', password: await secret(byNumber('173').id), answer: 'auto', toneHz: 660 },
    { ext: '174', password: await secret(ccExt.id), answer: 'auto', toneHz: 550 },
  ],
});

const channels = () =>
  cli('core show channels concise')
    .split('\n')
    .filter((l) => l.startsWith('PJSIP/'))
    .map((l) => {
      const f = l.split('!');
      return { name: f[0], state: f[4], bridge: f[12], seq: Number(f[13]?.split('.')[1]) };
    });
const hangupAll = async () => {
  cli('channel request hangup all');
  for (let i = 0; i < 40 && channels().length; i++) await sleep(250);
  await sleep(500);
};
async function signIn(p, who, temp) {
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', who.email);
  await p.fill('Password', temp ?? who.password);
  await p.click('Sign in');
  if (temp) {
    await p.waitFor(`location.pathname === '/change-password'`, 'forced password change');
    await p.fill('Current password', temp);
    await p.fill('New password', who.password);
    await p.fill('Repeat new password', who.password);
    await p.click('Change password');
  }
  await p.waitFor(`location.pathname === '/me'`, 'my phone');
}
const dotLabel = (p, n) =>
  p.evaluate(`document.querySelector('aside li[data-number="${n}"] .sr-only')?.textContent ?? ''`);

const watcher = await launch({ shotsDir });
const clicker = await launch({ shotsDir });
try {
  for (let i = 0; i < 180; i++) {
    const c = cli('pjsip show contacts');
    if (['172', '173', '174'].every((n) => new RegExp(`${n}/sip:.*Avail`).test(c))) break;
    await sleep(1000);
  }
  const reg = cli('pjsip show contacts');
  for (const n of ['172', '173', '174'])
    assert.match(reg, new RegExp(`${n}/sip:.*Avail`), `${n} registered`);
  await signIn(watcher, WEB);
  await watcher.waitFor(`!!document.querySelector('aside li[data-number="172"]')`, 'People list');
  await watcher.waitFor(
    `document.querySelector('aside li[data-number="172"] .sr-only')?.textContent === 'Available'`,
    '172 shown available',
    10_000,
  );
  await watcher.shot('m5-t3-01-people');

  // Presence: 173 calls 172. Poll Asterisk's hint and the dot side by side.
  const hintChange = (async () => {
    for (let i = 0; i < 200; i++) {
      if (!/State:Idle/.test(cli('core show hint 172'))) return Date.now();
      await sleep(20);
    }
    return null;
  })();
  const dotChange = (async () => {
    for (let i = 0; i < 1000; i++) {
      if ((await dotLabel(watcher, '172')) !== 'Available') return Date.now();
      await sleep(10);
    }
    return null;
  })();
  cli('channel originate PJSIP/173 extension 172@sp-from-ext');
  const [tAst, tUi] = await Promise.all([hintChange, dotChange]);
  assert.ok(tAst && tUi, `state change seen (asterisk ${tAst}, ui ${tUi})`);
  console.log(
    `presence: dot changed ${tUi - tAst} ms after Asterisk's hint (now "${await dotLabel(watcher, '172')}")`,
  );
  assert.ok(tUi - tAst < 1000, 'presence dot within 1 s');
  await watcher.waitFor(
    `document.querySelector('aside li[data-number="172"] .sr-only')?.textContent === 'On a call'`,
    '172 on a call',
  );
  await watcher.shot('m5-t3-02-on-a-call');
  await hangupAll();
  await watcher.waitFor(
    `document.querySelector('aside li[data-number="172"] .sr-only')?.textContent === 'Available'`,
    '172 available again',
  );
  console.log('presence: back to Available after hang-up');

  // Click-to-call: a user without the browser softphone; the desk phone (174) rings first.
  await signIn(clicker, CC, cc.temporaryPassword);
  await clicker.waitFor(`!!document.querySelector('aside li[data-number="172"]')`, 'People list');
  await clicker.click('Call Pat Desk');
  // Asterisk numbers channels in creation order (the part of the uniqueid after the dot).
  const created = {};
  for (let i = 0; i < 100 && Object.keys(created).length < 2; i++) {
    for (const c of channels()) {
      const n = /^PJSIP\/(\d+)-/.exec(c.name)?.[1];
      if (n && !(n in created)) created[n] = c.seq;
    }
    await sleep(50);
  }
  assert.ok(created['174'] < created['172'], `desk phone rang first: ${JSON.stringify(created)}`);
  await clicker.waitFor(
    `document.body.innerText.includes('Your desk phone is ringing')`,
    'tells the user to pick up',
  );
  for (let i = 0; i < 40; i++) {
    const c = channels();
    const a = c.find((x) => x.name.startsWith('PJSIP/174-'));
    const b = c.find((x) => x.name.startsWith('PJSIP/172-'));
    if (a?.bridge && a.bridge === b?.bridge) break;
    await sleep(250);
  }
  const c = channels();
  assert.equal(
    c.find((x) => x.name.startsWith('PJSIP/174-'))?.bridge,
    c.find((x) => x.name.startsWith('PJSIP/172-'))?.bridge,
    '174 and 172 talk',
  );
  console.log('click-to-call: 174 (desk) rang first, then 172; connected');
  await clicker.shot('m5-t3-03-click-to-call');
  await hangupAll();

  console.log('M5-T3 (presence, click-to-call): PASS');
} catch (e) {
  await watcher.shot('m5-t3-fail-watcher').catch(() => {});
  await clicker.shot('m5-t3-fail-clicker').catch(() => {});
  console.log(`FAIL: ${e.message}`);
  console.log(cli('pjsip show contacts'));
  console.log(cli('core show channels concise'));
  process.exitCode = 1;
} finally {
  await watcher.close();
  await clicker.close();
  phones.stop();
}
