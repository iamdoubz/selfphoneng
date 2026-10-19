// SPDX-License-Identifier: AGPL-3.0-or-later
// M10-T1: a Yealink added on the Phones page; its drawer shows the URL, user and password to type
// into the phone and a preview with the passwords masked. Then the phone's side: /prov/<mac>.cfg
// answers 401 without credentials and the file with them, and a baresip phone registers with
// nothing but the account from that file. The page then shows when and from where it was fetched.
// No real Yealink here: the hardware check stays open (09 M10).
// Runs on m2-live, after m1-t4.mjs.
// Usage: node scripts/e2e/m10-t1.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { launch } from './cdp.mjs';
import { startPhones } from './phones.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const MAC = '001565123456';
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
const ext = await (
  await fetch(`${base}/api/extensions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'selfphoneng', cookie },
    body: JSON.stringify({ number: '350', name: 'Desk Phone Dee' }),
  })
).json();
assert.ok(ext.id, JSON.stringify(ext));
const waitUntil = async (fn, what, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(300);
  }
  throw new Error(`timeout waiting for: ${what}`);
};
const pick = (label, text) =>
  p.evaluate(`(() => {
    const s = [...document.querySelectorAll('dialog[open] select')].find(s => s.labels?.[0]?.textContent === ${JSON.stringify(label)});
    const o = [...s.options].find(o => o.textContent.includes(${JSON.stringify(text)}));
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, o.value);
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
/** The value next to `term` in the drawer's setup box. */
const setupValue = (term) =>
  p.evaluate(`(() => {
    const dt = [...document.querySelectorAll('[aria-label="Set up the phone"] dt')].find(d => d.textContent === ${JSON.stringify(term)});
    return dt?.nextElementSibling?.textContent ?? '';
  })()`);

let phones;
const p = await launch({ shotsDir });
try {
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`);

  // Add the phone.
  await p.click('Phones');
  await p.click('Add phone');
  await p.waitFor(`!!document.querySelector('dialog[open]')`);
  await p.fill('MAC address', '00:15:65:12:34:5', 'dialog[open]');
  await p.fill('Model', 'T54W', 'dialog[open]');
  await p.waitFor(
    `[...document.querySelectorAll('dialog[open] option')].some(o => o.textContent.includes('Desk Phone Dee'))`,
    'users listed',
  );
  await pick('User', 'Desk Phone Dee');
  await p.click('Save', 'dialog[open]');
  await p.waitFor(
    `document.querySelector('dialog[open]').innerText.includes('A MAC address like')`,
    'short MAC refused',
  );
  await p.fill('MAC address', '00:15:65:12:34:56', 'dialog[open]');
  await p.click('Save', 'dialog[open]');
  await p.waitFor(`!!document.querySelector('[aria-label="Set up the phone"]')`, 'saved');
  assert.equal(await setupValue('Username'), MAC);
  assert.match(await setupValue('Server URL'), /\/prov\/$/);
  const provPassword = await setupValue('Password');
  assert.match(provPassword, /^[A-Za-z0-9]{20}$/);
  await p.click('Preview config', 'dialog[open]');
  await p.waitFor(`!!document.querySelector('[aria-label="Config preview"]')`, 'preview');
  const preview = await p.evaluate(
    `document.querySelector('[aria-label="Config preview"]').textContent`,
  );
  assert.match(preview, /account\.1\.user_name = 350/);
  assert.match(preview, /account\.1\.password = \*{8}/);
  assert.ok(!preview.includes(provPassword), 'preview shows the provisioning password');
  await p.shot('m10-t1-01-phone');
  console.log('phone 00:15:65:12:34:56 added in the UI (a short MAC refused); preview masked');

  // The phone's side.
  const url = `${base}/prov/${MAC}.cfg`;
  assert.equal((await fetch(url)).status, 401, 'no credentials: 401');
  const r = await fetch(url, {
    headers: { authorization: `Basic ${Buffer.from(`${MAC}:${provPassword}`).toString('base64')}` },
  });
  assert.equal(r.status, 200);
  const file = await r.text();
  const val = (k) => new RegExp(`^${k.replace(/\./g, '\\.')} = (.*)$`, 'm').exec(file)?.[1];
  assert.equal(val('account.1.user_name'), '350');
  console.log('the phone gets 401 without credentials and its file with them');

  // A phone that knows only what the file says registers.
  phones = startPhones({
    name: 'sp-live-phones-m10t1',
    net: NET,
    ast: AST,
    phones: [
      { ext: val('account.1.user_name'), password: val('account.1.password'), answer: 'auto' },
    ],
  });
  await waitUntil(
    () => /350\/sip:.*Avail/.test(cli('pjsip show contacts')),
    '350 registers',
    180_000,
  );
  console.log('a phone with only the account from the file registers as 350');

  await p.goto(`${base}/admin/devices`);
  await p.waitFor(`document.body.innerText.includes('Yealink T54W')`, 'listed');
  assert.doesNotMatch(await p.text(), /\bNever\b/);
  await p.shot('m10-t1-02-list');
  console.log('Phones lists it with the time and IP it fetched its settings from');
  console.log('M10-T1 (phones, provisioning): PASS');
} catch (e) {
  await p.shot('m10-t1-fail').catch(() => {});
  console.log(`FAIL: ${e.message}`);
  console.log(`browser errors: ${JSON.stringify(p.consoleErrors)}`);
  process.exitCode = 1;
} finally {
  await p.close();
  phones?.stop();
}
