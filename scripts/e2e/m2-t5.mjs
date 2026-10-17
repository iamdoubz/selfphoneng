// SPDX-License-Identifier: AGPL-3.0-or-later
// M2-T5 browser flow: create a user with the next free extension, edit the Phone tab, reveal and
// regenerate SIP credentials, and check the generated PJSIP file follows every step.
// Usage: node m2-t5.mjs <baseUrl> <adminEmail> <adminPassword> <asteriskConfigDir> <shotsDir>
// (the admin must already have changed the initial password; run m1-t4.mjs first on a fresh DB)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './cdp.mjs';

const [base, email, pw, confDir, shotsDir] = process.argv.slice(2);
const pjsip = () => readFileSync(join(confDir, 'pjsip_selfphoneng.conf'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 5000) => {
  for (const end = Date.now() + ms; ; await sleep(100)) {
    if (
      (() => {
        try {
          return fn();
        } catch {
          return false;
        }
      })()
    )
      return; // file may not exist yet
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
  }
};

const p = await launch({ shotsDir });
try {
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`);
  await p.click('Users & Extensions');
  await p.waitFor(`document.body.innerText.includes('Ext.')`, 'users table');

  // create with the next free number
  await p.click('New user');
  await p.waitFor(`!!document.querySelector('dialog[open]')`);
  await p.fill('Name', 'Carol Diaz');
  await p.fill('Email', 'carol@example.com');
  await p.click('Next free');
  await p.waitFor(
    `[...document.querySelectorAll('dialog[open] input')].some(i => i.value === '100')`,
    'next free = 100',
  );
  await p.shot('m2-01-new-user');
  const t0 = Date.now();
  await p.click('Create user');
  await p.waitFor(`document.body.innerText.includes('Temporary password')`, 'temp password');
  await p.click('Done');
  await until(() => pjsip().includes('[100]\ntype = endpoint'), 'endpoint 100 in pjsip config');
  console.log(`endpoint 100 written ${Date.now() - t0} ms after clicking Create`);
  await p.waitFor(`document.body.innerText.includes('Carol Diaz')`);

  // Phone tab
  await p.click('Edit Carol Diaz');
  await p.waitFor(
    `[...document.querySelectorAll('[role=tab]')].some(t => t.textContent === 'Phone' && !t.disabled)`,
    'phone tab enabled',
  );
  await p.click('Phone');
  await p.waitFor(`document.body.innerText.includes('Ring time')`);
  await p.fill('Ring time (seconds)', '30');
  await p.fill('Pickup group', 'sales');
  await p.evaluate(
    `(() => { const c = [...document.querySelectorAll('dialog[open] input[type=checkbox]')].find(i => i.closest('label').textContent.includes('Browser softphone')); c.click(); return true; })()`,
  );
  await p.shot('m2-02-phone-tab');
  await p.click('Save');
  await until(
    () => pjsip().includes('named_pickup_group = sales') && !pjsip().includes('[100-web]'),
    'phone settings in config',
  );

  // Credentials tab
  await p.click('Edit Carol Diaz');
  await p.waitFor(
    `[...document.querySelectorAll('[role=tab]')].some(t => t.textContent === 'Credentials' && !t.disabled)`,
  );
  await p.click('Credentials');
  await p.click('Reveal password');
  await p.waitFor(
    `/[A-Za-z0-9]{24}/.test(document.querySelector('dialog[open]').innerText)`,
    'password shown',
  );
  const pass1 = await p.evaluate(
    `document.querySelector('dialog[open]').innerText.match(/[A-Za-z0-9]{24}/)[0]`,
  );
  assert.ok(pjsip().includes(`password = ${pass1}`), 'revealed password is the configured one');
  await p.shot('m2-03-credentials');
  await p.click('New SIP password');
  await p.click('Yes, make a new password');
  await p.waitFor(`document.body.innerText.includes('New password saved.')`);
  await p.waitFor(
    `!document.querySelector('dialog[open]').innerText.includes('${pass1}')`,
    'new password shown',
  );
  await until(() => !pjsip().includes(pass1), 'old password gone from config');

  assert.deepEqual(p.consoleErrors, [], 'no console errors');
  console.log('M2-T5 browser flow: PASS');
} catch (e) {
  await p.shot('m2-FAILED').catch(() => {});
  console.error('FAIL:', e.message, '\nconsole:', p.consoleErrors);
  process.exitCode = 1;
} finally {
  await p.close();
}
