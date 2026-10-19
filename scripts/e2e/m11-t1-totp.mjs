// SPDX-License-Identifier: AGPL-3.0-or-later
// M11-T1 two-step sign-in in a browser: the admin turns it on from My account (scans the key,
// enters a code, gets 10 recovery codes), signs out, signs in with password then a code, then with
// a recovery code, and turns it off again (later scripts sign in with the password alone).
// Codes come from the api's own TOTP module, like an authenticator app would make them.
// Runs after m1-t4.mjs.
// Usage: node scripts/e2e/m11-t1-totp.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { launch } from './cdp.mjs';

const { stepAt, totpCode } = await import('../../apps/api/src/auth/totp.ts');
const [base, email, pw, shotsDir] = process.argv.slice(2);
const p = await launch({ shotsDir });
const signIn = async (code) => {
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`document.body.innerText.includes('Authentication code')`, 'asked for the code');
  await p.fill('Authentication code', code);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`, 'signed in');
};
const signOut = async () => {
  await p.click('Sign out');
  await p.waitFor(`location.pathname === '/login'`);
};
try {
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`);

  // Turn it on.
  await p.click('Account');
  await p.waitFor(`document.body.innerText.includes('Turn on two-step sign-in')`, 'status');
  await p.click('Turn on two-step sign-in');
  await p.waitFor(`!!document.querySelector('img[alt="Authenticator setup QR code"]')`, 'QR');
  const secret = await p.evaluate(
    `[...document.querySelectorAll('span.font-mono')].map(s => s.textContent).find(t => /^[A-Z2-7]{32}$/.test(t))`,
  );
  assert.match(secret, /^[A-Z2-7]{32}$/);
  await p.fill('2. Enter the 6-digit code it shows', '000000');
  await p.click('Turn on');
  await p.waitFor(`document.body.innerText.includes('doesn’t match')`, 'wrong code refused');
  await p.fill('2. Enter the 6-digit code it shows', totpCode(secret, stepAt()));
  await p.click('Turn on');
  await p.waitFor(`!!document.querySelector('ul[aria-label="Recovery codes"]')`, 'codes');
  const codes = await p.evaluate(
    `[...document.querySelectorAll('ul[aria-label="Recovery codes"] li')].map(l => l.textContent)`,
  );
  assert.equal(codes.length, 10);
  await p.shot('m11-t1-02-recovery-codes');
  console.log('two-step sign-in on from My account (a wrong code refused); 10 recovery codes');

  // Sign in with a code (the next step: the current one was spent turning it on).
  await signOut();
  await signIn(totpCode(secret, stepAt() + 1));
  console.log('signed in with password, then the authenticator code');

  // And with a recovery code.
  await signOut();
  await signIn(codes[0]);
  await p.click('Account');
  await p.waitFor(`document.body.innerText.includes('9 recovery codes left')`, '9 left');
  console.log('signed in with a recovery code; 9 left');

  // Off again.
  await p.fill('Your password', pw);
  await p.click('Turn off');
  await p.waitFor(`document.body.innerText.includes('Turn on two-step sign-in')`, 'off');
  console.log('turned off with the password');
  console.log('M11-T1 (two-step sign-in): PASS');
} catch (e) {
  await p.shot('m11-t1-totp-fail').catch(() => {});
  console.log(`FAIL: ${e.message}`);
  console.log(`browser errors: ${JSON.stringify(p.consoleErrors)}`);
  process.exitCode = 1;
} finally {
  await p.close();
}
