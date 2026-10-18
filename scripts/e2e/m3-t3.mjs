// SPDX-License-Identifier: AGPL-3.0-or-later
// M3-T3 in a browser: the default outbound rules (made with the first trunk), the test box, a
// user's calling permission, reordering, and the result in the live Asterisk.
// Run after m3-t1.mjs and m3-t2.mjs on the m2-live setup.
// Usage: node scripts/e2e/m3-t3.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { launch } from './cdp.mjs';

const cli = (cmd) =>
  spawnSync('docker', ['exec', 'sp-live-ast', 'asterisk', '-rx', cmd], { encoding: 'utf8' })
    .stdout ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [base, email, pw, shotsDir] = process.argv.slice(2);
const p = await launch({ shotsDir });
const body = () => p.evaluate('document.body.innerText');
async function testNumber(n) {
  await p.fill('Dials', n);
  await p.evaluate(
    `[...document.querySelectorAll('form button[type=submit]')].find(b => b.textContent === 'Test').click(), true`,
  );
  await p.waitFor(`!!document.querySelector('form [role=status]')`, 'test result');
  await sleep(300);
  return p.evaluate(`document.querySelector('form [role=status]').innerText`);
}

try {
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`);
  await p.click('Outbound rules');
  await p.waitFor(`document.body.innerText.includes('Test a number')`, 'outbound page');
  const text = await body();
  const order = ['Toll-free', 'Local and national (US/Canada)', 'International'].map((n) =>
    text.indexOf(n),
  );
  assert.ok(order[0] < order[1] && order[1] < order[2], `default rules in order:\n${text}`);
  await p.shot('m3-t3-01-rules');

  let r = await testNumber('(312) 555-0000');
  assert.match(r, /Local and national \(US\/Canada\) sends 13125550000 via voip\.ms/);
  console.log('test box:', r);
  r = await testNumber('011 44 20 7946 0958');
  assert.match(r, /No enabled route matches/);
  console.log('test box:', r);

  // Dan (101) gets "Local and toll-free" only: national is now denied, toll-free still works.
  await p.click('Users & Extensions');
  await p.waitFor(`document.body.innerText.includes('dan@example.com')`, 'users list');
  await p.click('Edit Dan Doe');
  await p.waitFor(
    `[...document.querySelectorAll('[role=tab]')].some(t => t.textContent === 'Calling' && !t.disabled)`,
    'Calling tab enabled',
  );
  await p.click('Calling');
  await p.fill('Calling permission', 'local');
  await p.shot('m3-t3-02-calling-tab');
  await p.evaluate(`document.querySelector('dialog button[form=user-calling-form]').click(), true`);
  await p.waitFor(`!document.querySelector('dialog[open]')`, 'drawer closed');
  await p.click('Outbound rules');
  await p.waitFor(`document.body.innerText.includes('Test a number')`);
  r = await testNumber('3125550000');
  assert.match(
    r,
    /Denied: "Local and national \(US\/Canada\)" needs calling permission "national"/,
  );
  console.log('test box:', r);
  r = await testNumber('1-800-555-1234');
  assert.match(r, /Toll-free sends 18005551234/);
  await p.shot('m3-t3-03-denied');

  // Reorder: national above toll-free. The test box and Asterisk's include order both follow.
  await p.click('Move Local and national (US/Canada) up');
  await p.waitFor(
    `document.body.innerText.indexOf('Local and national') < document.body.innerText.indexOf('Toll-free')`,
    'new order on screen',
  );
  r = await testNumber('1-800-555-1234');
  assert.match(r, /Denied: "Local and national/); // 1NXXNXXXXXX now matches first
  let first = '';
  for (let i = 0; i < 30 && !first.includes('_NXXNXXXXXX'); i++) {
    await sleep(100);
    const inc = cli('dialplan show sp-outbound-routes');
    const ids = [...inc.matchAll(/Include =>\s+'sp-or-([0-9a-f-]+)'/g)].map((m) => m[1]);
    assert.equal(ids.length, 2, `two enabled rules included (international is off):\n${inc}`);
    first = cli(`dialplan show sp-or-${ids[0]}`);
  }
  assert.match(first, /_NXXNXXXXXX/, 'national is included first now');
  assert.deepEqual(p.consoleErrors, [], 'no console errors');
  console.log('Asterisk: include order follows the new rule order');
  console.log('M3-T3 (UI → Asterisk): PASS');
} catch (e) {
  await p.shot('m3-t3-FAILED').catch(() => {});
  console.error('FAIL:', e.message, '\nconsole:', p.consoleErrors);
  process.exitCode = 1;
} finally {
  await p.close();
}
