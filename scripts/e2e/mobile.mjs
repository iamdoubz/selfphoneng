// SPDX-License-Identifier: AGPL-3.0-or-later
// Screenshots of the admin shell at 360 px (05 §1: works at 360 px; tables become cards).
import { launch } from './cdp.mjs';
const [base, email, pw, shotsDir] = process.argv.slice(2);
const p = await launch({ width: 360, height: 740, shotsDir });
try {
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`);
  await p.goto(`${base}/admin/users`);
  await p.waitFor(`document.body.innerText.includes('admin@example.com')`);
  const overflow = await p.evaluate('document.documentElement.scrollWidth > innerWidth');
  await p.shot('m-users');
  await p.click('Menu');
  await p.waitFor(`document.body.innerText.includes('Trunks')`);
  await p.shot('m-menu');
  console.log('horizontal overflow:', overflow, '| console errors:', p.consoleErrors);
} finally {
  await p.close();
}
