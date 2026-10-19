// SPDX-License-Identifier: AGPL-3.0-or-later
// M10-T3 as a user: My settings → "Set up a phone app" shows a Linphone QR and its link. Fetching
// the link (no other credentials, as Linphone does) gives the account XML, and a baresip phone
// given only the user name and password from it registers. A changed token gets nothing.
// Linphone itself isn't run here: scanning the QR with the app is the owner's check (09 M10).
// Runs on m2-live, after m1-t4.mjs.
// Usage: node scripts/e2e/m10-t3.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { launch } from './cdp.mjs';
import { startPhones } from './phones.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const USER = { email: 'lin@example.com', password: 'lin-new-password-123' };
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
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      'x-requested-with': 'selfphoneng',
      cookie,
    },
    body: body && JSON.stringify(body),
  });
  const json = await r.json();
  assert.ok(r.ok, `${method} ${url}: ${r.status} ${JSON.stringify(json)}`);
  return json;
};
const user = await api('POST', '/api/users', { email: USER.email, displayName: 'Lin Mobile' });
await api('POST', '/api/extensions', { number: '370', name: 'Lin Mobile', userId: user.user.id });

let phones;
const p = await launch({ shotsDir });
try {
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', USER.email);
  await p.fill('Password', user.temporaryPassword);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/change-password'`, 'forced password change');
  await p.fill('Current password', user.temporaryPassword);
  await p.fill('New password', USER.password);
  await p.fill('Repeat new password', USER.password);
  await p.click('Change password');
  await p.waitFor(`location.pathname === '/me'`, 'my phone');
  await p.goto(`${base}/me/settings`);
  await p.waitFor(`document.body.innerText.includes('Set up a phone app')`);
  await p.click('Show setup QR code');
  await p.waitFor(
    `document.querySelector('img[alt="Linphone setup QR code"]')?.naturalWidth > 0`,
    'QR shown',
  );
  const url = await p.evaluate(
    `[...document.querySelectorAll('p')].find(e => e.textContent.includes('/prov/linphone/')).textContent`,
  );
  assert.match(url, /^https:\/\/[^/]+\/prov\/linphone\/[A-Za-z0-9_-]+\.xml$/);
  await p.evaluate(
    `document.querySelector('img[alt="Linphone setup QR code"]').scrollIntoView({ block: 'center' }) ?? true`,
  );
  await p.shot('m10-t3-01-qr');
  console.log('My settings: the setup QR and its link');

  // What Linphone does with the link (the api here is plain HTTP on its own port).
  const path = new URL(url).pathname;
  const res = await fetch(`${base}${path}`);
  assert.equal(res.status, 200);
  const xml = await res.text();
  const entry = (n) => new RegExp(`<entry name="${n}">([^<]*)</entry>`).exec(xml)?.[1];
  assert.equal(entry('username'), '370');
  assert.match(xml, /reg_identity">"Lin Mobile" &lt;sip:370@/);
  const tampered = path.replace(/.(\.xml)$/, (m, x) => (m[0] === 'A' ? 'B' : 'A') + x);
  assert.equal((await fetch(`${base}${tampered}`)).status, 404, 'a changed token');
  console.log('the link gives the account XML; a changed token gets 404');

  phones = startPhones({
    name: 'sp-live-phones-m10t3',
    net: NET,
    ast: AST,
    phones: [{ ext: entry('username'), password: entry('passwd'), answer: 'auto' }],
  });
  const end = Date.now() + 180_000;
  while (Date.now() < end && !/370\/sip:.*Avail/.test(cli('pjsip show contacts'))) await sleep(500);
  assert.match(cli('pjsip show contacts'), /370\/sip:.*Avail/, '370 registered');
  console.log('a phone with only the user name and password from the XML registers as 370');
  console.log('M10-T3 (Linphone QR): PASS');
} catch (e) {
  await p.shot('m10-t3-fail').catch(() => {});
  console.log(`FAIL: ${e.message}`);
  console.log(`browser errors: ${JSON.stringify(p.consoleErrors)}`);
  process.exitCode = 1;
} finally {
  await p.close();
  phones?.stop();
}
