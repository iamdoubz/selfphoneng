// SPDX-License-Identifier: AGPL-3.0-or-later
// System → Diagnostics (08 §2.6) in a browser: the server's own checks show, the network tests
// stay off until a probe is set in Settings → Network, then a quick and a complete test run
// against a probe started here (on 127.0.0.1, so it also flags that it's inside the network).
// Runs after m1-t4.mjs; Asterisk isn't needed (the SIP rows then show how to fix them).
// Usage: node scripts/e2e/m11-diagnostics.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { launch } from './cdp.mjs';

const { createProbe } = await import('../../apps/probe/src/server.ts');
const [base, email, pw, shotsDir] = process.argv.slice(2);
const probe = createProbe();
await new Promise((r) => probe.listen(18090, '127.0.0.1', r));
const p = await launch({ shotsDir });
const text = (s) => `document.body.innerText.includes(${JSON.stringify(s)})`;
try {
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`, 'signed in');

  await p.goto(`${base}/admin/system`);
  await p.waitFor(`!!document.querySelector('ul[aria-label="Server checks"]')`, 'server checks');
  for (const label of ['Public IP', 'DNS for', 'Where phones can sign in from', 'Call audio ports'])
    await p.waitFor(text(label), label);
  await p.waitFor(text('Set a probe first'), 'no probe yet');
  assert.equal(
    await p.evaluate(
      `[...document.querySelectorAll('button')].find(b => b.textContent === 'Quick network test').disabled`,
    ),
    true,
  );
  await p.evaluate(`document.querySelector('ul[aria-label="Server checks"]').scrollIntoView()`);
  await p.shot('m11-diag-01-server-checks');
  console.log('server checks shown; network tests wait for a probe');

  await p.goto(`${base}/admin/settings/network`);
  await p.waitFor(text('Network test probe'), 'network settings');
  await p.fill('Network test probe', 'http://127.0.0.1:18090');
  await p.click('Save');
  await p.waitFor(text('Saved.'), 'saved');

  await p.goto(`${base}/admin/system`);
  await p.waitFor(text('Network test probe'), 'probe row');
  await p.waitFor(
    `[...document.querySelectorAll('button')].find(b => b.textContent === 'Quick network test')?.disabled === false`,
    'quick enabled',
  );
  await p.click('Quick network test');
  await p.waitFor(
    `!!document.querySelector('ul[aria-label="Quick network test"]')`,
    'quick results',
    40_000,
  );
  for (const label of ['Tested address', 'HTTPS (TCP 443)', 'SIP (UDP 5060)', 'How to fix'])
    await p.waitFor(text(label), label);
  await p.waitFor(text('a private address'), 'inside-the-network warning');
  await p.evaluate(
    `document.querySelector('ul[aria-label="Quick network test"]').scrollIntoView()`,
  );
  await p.shot('m11-diag-02-quick');
  console.log('quick test: results with fixes');

  await p.click('Complete network test');
  await p.waitFor(
    `!!document.querySelector('ul[aria-label="Complete network test"]')`,
    'complete results',
    40_000,
  );
  await p.waitFor(text('Browser phone (/ws)'), '/ws row');
  await p.waitFor(text('Call audio (UDP'), 'audio row');
  await p.evaluate(
    `document.querySelector('ul[aria-label="Complete network test"]').scrollIntoView()`,
  );
  await p.shot('m11-diag-03-complete');
  console.log('complete test: /ws and call audio too');
} finally {
  await p.close();
  probe.close();
}
