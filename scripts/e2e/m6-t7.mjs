// SPDX-License-Identifier: AGPL-3.0-or-later
// M6-T7 with real phones: feature codes *78/*79 (DND), *72/*73 (forward always), *43 (echo),
// *65 (say my extension), **N (directed pickup), *8 (group pickup); a refused *72 shows a toast;
// forwarding set on /me/settings reaches AstDB and routes calls.
// User fwd@example.com has desk phone 198; 199 auto-answers; 200 rings without answering.
// Runs on the m2-live setup after m1-t4.mjs.
// Usage: node scripts/e2e/m6-t7.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { launch } from './cdp.mjs';
import { startPhones } from './phones.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const USER = { email: 'fwd@example.com', password: 'fwd-new-password-123' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (cmd) =>
  spawnSync('docker', ['exec', AST, 'asterisk', '-rx', cmd], { encoding: 'utf8' }).stdout ?? '';
// Asterisk colors its log (e.g. the arguments in "Executing" lines): strip the escape codes.
// eslint-disable-next-line no-control-regex -- matching ANSI escapes is the point
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
const created = await api('POST', '/api/users', { email: USER.email, displayName: 'Fay Forward' });
const desk = async (number, name, extra = {}) => {
  const e = await api('POST', '/api/extensions', { number, name, ...extra });
  return (await api('GET', `/api/extensions/${e.id}/sip-credentials`)).password;
};
const phones = startPhones({
  name: 'sp-live-phones-m6t7',
  net: NET,
  ast: AST,
  phones: [
    {
      ext: '198',
      password: await desk('198', 'Fay Forward', {
        userId: created.user.id,
        outboundClass: 'internal',
        pickupGroup: 'front',
      }),
      answer: 'auto',
    },
    { ext: '199', password: await desk('199', 'Gus Target'), answer: 'auto', toneHz: 660 },
    {
      ext: '200',
      password: await desk('200', 'Hal Ringing', { pickupGroup: 'front' }),
      answer: 'manual',
    },
  ],
});

const waitUntil = async (fn, what, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  throw new Error(`timeout waiting for: ${what}`);
};
const channels = () =>
  cli('core show channels concise')
    .split('\n')
    .filter((l) => /^(PJSIP|Local)\//.test(l))
    .map((l) => {
      const f = l.split('!');
      return { name: f[0], bridge: f[12] };
    });
const hangupAll = async () => {
  cli('channel request hangup all');
  await waitUntil(() => channels().length === 0, 'calls ended');
  await sleep(500);
};
/** Phone 198 dials a code (it auto-answers the originate, then runs sp-from-ext). */
async function dial(code, done) {
  const at = astLog().length;
  cli(`channel originate PJSIP/198 extension ${code}@sp-from-ext`);
  await waitUntil(() => done(astLog().slice(at)), `${code} ran`);
  await hangupAll();
}
const me = () => fetch(`${base}/api/me`, { headers: { cookie: userCookie } }).then((r) => r.json());
const astdb = () => cli('database show SP');
let userCookie = '';

const p = await launch({ shotsDir });
try {
  await waitUntil(
    () =>
      ['198', '199', '200'].every((n) =>
        new RegExp(`${n}/sip:.*Avail`).test(cli('pjsip show contacts')),
      ),
    'phones registered',
    180_000,
  );
  // The user signs in (first login: change password) and opens Settings.
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', USER.email);
  await p.fill('Password', created.temporaryPassword);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/change-password'`);
  await p.fill('Current password', created.temporaryPassword);
  await p.fill('New password', USER.password);
  await p.fill('Repeat new password', USER.password);
  await p.click('Change password');
  await p.waitFor(`location.pathname === '/me'`);
  userCookie = (
    await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'selfphoneng' },
      body: JSON.stringify(USER),
    })
  ).headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  await p.waitFor(`document.body.innerText.includes('Not forwarding.')`, 'status card');

  // *78: DND on from the phone → database, AstDB, the page's switch; calls get busy → voicemail.
  await dial('*78', (l) => /Playing 'do-not-disturb/.test(l));
  await waitUntil(async () => (await me()).dnd, 'DND in the database');
  assert.match(astdb(), /\/SP\/DND\/198\s*:\s*1/);
  await p.waitFor(`document.querySelector('[role=switch]')?.checked === true`, 'switch on', 10_000);
  let at = astLog().length;
  cli('channel originate Local/198@sp-from-ext application Wait 10');
  await waitUntil(
    () => /VoiceMail\("[^"]+", "198@default,b"\)/.test(astLog().slice(at)),
    'busy voicemail',
  );
  await hangupAll();
  await dial('*79', (l) => /Playing 'do-not-disturb/.test(l));
  await waitUntil(async () => !(await me()).dnd, 'DND off');
  console.log('*78/*79: DND in database, AstDB and the page; a call meanwhile went to voicemail');

  // *72199: forward everything to 199; a call to 198 rings 199.
  await dial('*72199', (l) => /Playing 'call-fwd-unconditional/.test(l));
  await waitUntil(async () => (await me()).cfu === '199', 'CFU stored');
  at = astLog().length;
  cli('channel originate Local/198@sp-from-ext application Wait 10');
  await waitUntil(() => /Called PJSIP\/199\//.test(astLog().slice(at)), 'forwarded to 199');
  assert.doesNotMatch(astLog().slice(at), /Called PJSIP\/198\//);
  await hangupAll();
  await dial('*73', (l) => /Playing 'call-fwd-unconditional/.test(l));
  await waitUntil(async () => (await me()).cfu === null, 'CFU off');
  console.log('*72199 / *73: a call to 198 went to 199 while forwarded');

  // *72 to an outside number: 198 may only call internally → refused, undone, toast.
  await dial('*7213125551234', (l) => /Playing 'call-fwd-unconditional/.test(l));
  await p.waitFor(
    `document.body.innerText.includes('Call forwarding not turned on')`,
    'toast',
    10_000,
  );
  assert.equal((await me()).cfu, null);
  assert.doesNotMatch(astdb(), /CFU\/198/);
  await p.shot('m6-t7-01-toast');
  console.log('*72 to an outside number: refused, removed from AstDB, toast shown');

  // Settings page: "when you don't answer, forward to 199".
  await p.click('Settings');
  await p.fill('When you don’t answer, forward to', '199');
  await p.click('Save forwarding');
  await p.waitFor(`document.body.innerText.includes('Saved.')`);
  assert.match(astdb(), /\/SP\/CFNA\/198\s*:\s*199/);
  await p.fill('Forward all calls to', '(312) 555-1234');
  await p.click('Save forwarding');
  await p.waitFor(
    `/doesn't allow|can't go out/.test(document.body.innerText)`,
    'refused in the form',
  );
  await p.shot('m6-t7-02-settings');
  console.log('settings page: no-answer forward saved to AstDB; an outside number refused');

  await dial('*43', (l) => /Playing 'demo-echotest/.test(l)); // Echo() follows the long prompt
  await dial('*65', (l) => /SayDigits\("[^"]+", "198"\)/.test(l));
  console.log('*43 echo test and *65 say my extension');

  // Pickup: 200 rings (never answers); 198 takes it with **200, then with *8 (same group).
  for (const code of ['**200', '*8']) {
    cli('channel originate Local/200@sp-from-ext application Wait 30');
    await waitUntil(() => channels().some((c) => c.name.startsWith('PJSIP/200-')), '200 rings');
    at = astLog().length;
    cli(`channel originate PJSIP/198 extension ${code}@sp-from-ext`);
    await waitUntil(
      () =>
        /Pickup|picked up/i.test(astLog().slice(at)) &&
        !channels().some((c) => c.name.startsWith('PJSIP/200-')),
      `${code} picks up`,
    );
    console.log(`${code}: 198 picked up the call ringing at 200`);
    await hangupAll();
  }

  console.log('M6-T7 (feature codes, forwarding): PASS');
} catch (e) {
  await p.shot('m6-t7-fail').catch(() => {});
  console.log(`FAIL: ${e.message}`);
  console.log(`browser errors: ${JSON.stringify(p.consoleErrors)}`);
  process.exitCode = 1;
} finally {
  await p.close();
  phones.stop();
}
