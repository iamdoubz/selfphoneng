// SPDX-License-Identifier: AGPL-3.0-or-later
// M3-T2 in a browser: add a phone number routed to a user and see the inbound dialplan reach the
// live Asterisk. Run after m3-t1.mjs (needs its trunk) on the m2-live setup.
// Usage: node scripts/e2e/m3-t2.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { launch } from './cdp.mjs';

const AST = 'sp-live-ast';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (cmd) =>
  spawnSync('docker', ['exec', AST, 'asterisk', '-rx', cmd], { encoding: 'utf8' }).stdout ?? '';
const [base, email, pw, shotsDir] = process.argv.slice(2);

const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-requested-with': 'selfphoneng' },
  body: JSON.stringify({ email, password: pw }),
});
const cookie = login.headers.get('set-cookie').split(';')[0];
const api = async (method, path, body) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { cookie, 'x-requested-with': 'selfphoneng', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.ok(r.ok, `${method} ${path}: ${r.status} ${await r.clone().text()}`);
  return r.json();
};
const { user } = await api('POST', '/api/users', {
  email: 'dan@example.com',
  displayName: 'Dan Doe',
});
await api('POST', '/api/extensions', { number: '101', name: 'Dan Doe', userId: user.id });

const p = await launch({ shotsDir });
/** Sets a <select> found by its aria-label, the way a user would. */
const choose = (ariaLabel, value) =>
  p.evaluate(`(() => {
    const el = document.querySelector('select[aria-label="${ariaLabel}"]');
    if (!el) throw new Error('no select ${ariaLabel}');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
try {
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`);
  await p.click('Phone numbers');
  await p.waitFor(`document.body.innerText.includes('No numbers yet')`, 'empty numbers page');
  await p.click('Add number');
  await p.waitFor(`!!document.querySelector('#did-form')`);
  await p.fill('Phone number', '312.555.1234');
  await p.fill('Label', 'Main line');
  await choose('When someone calls this number: type', 'user');
  await p.waitFor(
    `[...document.querySelectorAll('select[aria-label="When someone calls this number: user"] option')].some(o => o.textContent.includes('Dan Doe'))`,
    'user list',
  );
  await p.shot('m3-t2-01-form');
  await p.evaluate(`document.querySelector('dialog button[form=did-form]').click(), true`);
  await p.waitFor(
    `document.body.innerText.includes('(312) 555-1234') && document.body.innerText.includes('→ Ring Dan Doe (101)')`,
    'number listed with its destination',
  );
  await p.shot('m3-t2-02-list');
  console.log('UI: (312) 555-1234 → Ring Dan Doe (101)');

  let shown = '';
  for (let i = 0; i < 40 && !shown.includes('Goto(sp-local-numbers,101,1)'); i++) {
    await sleep(100);
    shown = cli('dialplan show 13125551234@sp-inbound');
  }
  assert.match(shown, /Goto\(sp-local-numbers,101,1\)/, 'sp-inbound in Asterisk');
  assert.match(cli('dialplan show sp-did-exists'), /'13125551234'/, 'sp-did-exists in Asterisk');
  console.log('Asterisk: 13125551234@sp-inbound → sp-local-numbers,101');

  // The extension is now in use: the API refuses to delete it and says where.
  const r = await fetch(`${base}/api/extensions`, { headers: { cookie } });
  const ext = (await r.json()).items.find((e) => e.number === '101');
  const del = await fetch(`${base}/api/extensions/${ext.id}`, {
    method: 'DELETE',
    headers: { cookie, 'x-requested-with': 'selfphoneng' },
  });
  assert.equal(del.status, 409);
  assert.deepEqual((await del.json()).error.details.usedBy, ['number (312) 555-1234']);
  assert.deepEqual(p.consoleErrors, [], 'no console errors');
  console.log('M3-T2 (UI → Asterisk): PASS');
} catch (e) {
  await p.shot('m3-t2-FAILED').catch(() => {});
  console.error('FAIL:', e.message, '\nconsole:', p.consoleErrors);
  process.exitCode = 1;
} finally {
  await p.close();
}
