// SPDX-License-Identifier: AGPL-3.0-or-later
// M7-T2 end to end: real calls (231 → 230 answered; 231 → 230 while 230 is on DND → voicemail)
// become call history rows (AMI Cdr → cdr → calls); the admin sees them, filters and exports CSV;
// user hist@example.com (230) sees them on /me/calls, a missed call on Home, and Call back rings
// their desk phone first. Runs on the m2-live setup after m1-t4.mjs.
// Usage: node scripts/e2e/m7-t2.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { launch } from './cdp.mjs';
import { startPhones } from './phones.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const USER = { email: 'hist@example.com', password: 'hist-new-password-123' };
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
const created = await api('POST', '/api/users', { email: USER.email, displayName: 'Hal History' });
const mk = async (number, name, extra = {}) => {
  const e = await api('POST', '/api/extensions', { number, name, ...extra });
  return {
    id: e.id,
    password: (await api('GET', `/api/extensions/${e.id}/sip-credentials`)).password,
  };
};
const hal = await mk('230', 'Hal History', { userId: created.user.id });
const cy = await mk('231', 'Cy Caller');
const phones = startPhones({
  name: 'sp-live-phones-m7t2',
  net: NET,
  ast: AST,
  phones: [
    { ext: '230', password: hal.password, answer: 'auto' },
    { ext: '231', password: cy.password, answer: 'auto', toneHz: 660 },
  ],
});
const waitUntil = async (fn, what, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(300);
  }
  throw new Error(`timeout waiting for: ${what}`);
};
const hangupAll = async () => {
  cli('channel request hangup all');
  await waitUntil(() => !/(PJSIP|Local)\//.test(cli('core show channels concise')), 'calls ended');
};
const halCalls = async () => (await api('GET', `/api/calls?extensionId=${hal.id}`)).items;

const p = await launch({ shotsDir });
try {
  await waitUntil(
    () =>
      ['230', '231'].every((n) => new RegExp(`${n}/sip:.*Avail`).test(cli('pjsip show contacts'))),
    'phones registered',
    180_000,
  );
  // 1. 231 calls 230, who answers; 4 s of talk.
  cli('channel originate PJSIP/231 extension 230@sp-from-ext');
  await sleep(5000);
  await hangupAll();
  // 2. 230 turns on DND: 231's call goes to voicemail (a missed call for Hal).
  await api('PATCH', `/api/extensions/${hal.id}`, { voicemailEnabled: true });
  cli('database put SP DND/230 1');
  cli('channel originate PJSIP/231 extension 230@sp-from-ext');
  await waitUntil(() => /VoiceMail/.test(cli('core show channels concise')), 'voicemail', 20_000);
  await sleep(6000);
  await hangupAll();
  cli('database del SP DND/230');
  await waitUntil(async () => (await halCalls()).length === 2, 'two calls aggregated', 30_000);
  const [vm, answered] = await halCalls();
  assert.equal(answered.status, 'answered');
  assert.equal(answered.answeredBy.number, '230');
  assert.ok(answered.talkSeconds >= 3, `talk ${answered.talkSeconds}`);
  assert.equal(vm.status, 'voicemail');
  console.log(`real calls aggregated: answered (${answered.talkSeconds} s) and voicemail`);

  // Admin: Call history, filter, expand, CSV.
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`);
  await p.click('Call history');
  await p.waitFor(`document.body.innerText.includes('Cy Caller')`, 'calls listed');
  await p.evaluate(
    `(() => { const s = [...document.querySelectorAll('select')].find(s => s.labels[0]?.textContent === 'Status'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'voicemail'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
  );
  await p.click('Apply');
  await p.waitFor(
    `document.querySelectorAll('ul[aria-label=Calls] > li button[aria-expanded]').length >= 1 && [...document.querySelectorAll('ul[aria-label=Calls] > li')].every(li => li.innerText.includes('voicemail'))`,
    'filtered',
  );
  await p.evaluate(
    `document.querySelector('ul[aria-label=Calls] > li button[aria-expanded]').click(), true`,
  );
  await p.waitFor(
    `!!document.querySelector('table caption') && document.querySelector('tbody').innerText.includes('PJSIP/231-')`,
    'legs shown',
  );
  await p.shot('m7-t2-01-history');
  const csv = await p.evaluate(
    `fetch(document.querySelector('a[href*="export.csv"]').href).then(r => r.text())`,
  );
  assert.match(csv, /^started,direction,status/);
  assert.match(csv, /,internal,voicemail,231,Cy Caller,230,/);
  console.log('admin: history listed, filtered to voicemail, legs expanded, CSV exported');

  // The user: /me/calls, Home missed calls, Call back (desk phone first).
  await p.click('Sign out');
  await p.waitFor(`location.pathname === '/login'`);
  await p.fill('Email', USER.email);
  await p.fill('Password', created.temporaryPassword);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/change-password'`);
  await p.fill('Current password', created.temporaryPassword);
  await p.fill('New password', USER.password);
  await p.fill('Repeat new password', USER.password);
  await p.click('Change password');
  await p.waitFor(`location.pathname === '/me'`);
  await p.waitFor(
    `document.querySelector('[aria-labelledby=missed-h]')?.innerText.includes('Cy Caller')`,
    'missed call on Home',
  );
  await p.click('Calls');
  await p.waitFor(
    `document.querySelectorAll('button[aria-label^="Call back"]').length === 2`,
    'my calls',
  );
  await p.shot('m7-t2-02-my-calls');
  const before = cli('core show channels concise');
  assert.doesNotMatch(before, /PJSIP\//);
  await p.click('Call back 231');
  await waitUntil(
    () => /PJSIP\/230-/.test(cli('core show channels concise')),
    'desk phone rings first',
  );
  await waitUntil(() => /PJSIP\/231-/.test(cli('core show channels concise')), 'then 231');
  await p.waitFor(`document.body.innerText.includes('Your desk phone is ringing')`);
  await hangupAll();
  console.log('user: missed call on Home, my calls listed, Call back rang 230 then 231');
  console.log('M7-T2 (call history): PASS');
} catch (e) {
  await p.shot('m7-t2-fail').catch(() => {});
  console.log(`FAIL: ${e.message}`);
  console.log(`browser errors: ${JSON.stringify(p.consoleErrors)}`);
  process.exitCode = 1;
} finally {
  await p.close();
  phones.stop();
}
