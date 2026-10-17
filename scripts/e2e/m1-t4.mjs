// SPDX-License-Identifier: AGPL-3.0-or-later
// M1-T4 acceptance: admin logs in, is forced to change the password, then creates/edits/deletes a user.
// Usage: node m1-t4.mjs <baseUrl> <adminEmail> <adminInitialPassword> <shotsDir>
import assert from 'node:assert/strict';
import { launch } from './cdp.mjs';

const [base, email, initialPw, shotsDir] = process.argv.slice(2);
const NEW_PW = 'correct-horse-battery-staple';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const p = await launch({ shotsDir });
try {
  await p.goto(`${base}/admin/users`);
  await p.waitFor(`location.pathname === '/login'`, 'redirect to /login');
  await p.shot('01-login');

  await p.fill('Email', email);
  await p.fill('Password', initialPw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/change-password'`, 'forced password change');
  await p.shot('02-change-password');

  await p.fill('Current password', initialPw);
  await p.fill('New password', 'short');
  await p.fill('Repeat new password', 'short');
  await p.click('Change password');
  await p.waitFor(
    `document.body.innerText.includes('at least 10 characters')`,
    'min length error shown',
  );

  await p.fill('New password', NEW_PW);
  await p.fill('Repeat new password', NEW_PW);
  await p.click('Change password');
  await p.waitFor(`location.pathname === '/admin'`, 'admin dashboard after change');
  assert.match(await p.text(), /Coming in M2/);

  await p.click('Users & Extensions');
  await p.waitFor(`document.body.innerText.includes('Administrator')`, 'users table');
  await p.shot('03-users');

  // create
  await p.click('New user');
  await p.waitFor(`!!document.querySelector('dialog[open]')`, 'drawer open');
  await p.fill('Name', 'Ann Lee');
  await p.fill('Email', 'ann@example.com');
  await p.shot('04-new-user');
  await p.click('Create user');
  await p.waitFor(`document.body.innerText.includes('Temporary password')`, 'temp password dialog');
  const temp = await p.evaluate(`document.querySelector('dialog[open] code').textContent`);
  assert.match(temp, /^[A-Za-z0-9]{16}$/);
  await p.shot('05-temp-password');
  await p.click('Done');
  await p.waitFor(`document.body.innerText.includes('ann@example.com')`, 'new user in table');

  // edit
  await p.click('Edit Ann Lee');
  await p.waitFor(`!!document.querySelector('dialog[open]')`, 'edit drawer');
  await p.fill('Name', 'Ann B. Lee');
  await p.fill('Role', 'admin');
  await p.click('Save');
  await p.waitFor(`document.body.innerText.includes('Ann B. Lee')`, 'edited name in table');

  // delete
  await p.click('Delete Ann B. Lee');
  await p.waitFor(
    `document.body.innerText.includes('Delete Ann B. Lee?') || !!document.querySelector('dialog[open]')`,
    'confirm',
  );
  await p.shot('06-confirm-delete');
  await p.click('Delete');
  await p.waitFor(`!document.body.innerText.includes('ann@example.com')`, 'user removed');
  await p.shot('07-after-delete');

  // log out and back in with the new password
  await p.click('Sign out');
  await p.waitFor(`location.pathname === '/login'`, 'signed out');
  await p.fill('Email', email);
  await p.fill('Password', NEW_PW);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`, 'signed back in');
  await sleep(200);

  assert.deepEqual(p.consoleErrors, [], 'no console errors');
  console.log('M1-T4 browser flow: PASS');
} catch (e) {
  await p.shot('FAILED').catch(() => {});
  console.error(
    'FAIL:',
    e.message,
    '\npath:',
    await p.path().catch(() => '?'),
    '\nconsole:',
    p.consoleErrors,
  );
  process.exitCode = 1;
} finally {
  await p.close();
}
