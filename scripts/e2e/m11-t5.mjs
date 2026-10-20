// SPDX-License-Identifier: AGPL-3.0-or-later
// M11-T5: API tokens and webhooks, end to end.
// - Settings → API tokens makes a token in the browser; a script uses it (no cookie, no
//   X-Requested-With) to add extension 201, can't manage tokens with it, and it stops working once
//   revoked in the browser.
// - Settings → Webhooks adds a webhook to a receiver on this host: the test is refused (private
//   address) until "Allow addresses on private networks" is ticked, then arrives signed.
// - A real call to 201 (Local channel, goes to voicemail) sends call.started, call.ended and
//   voicemail.new, every one with a valid signature. The receiver fails the first POST with a 500:
//   it comes again a minute later.
// Runs on the m2-live setup with a voicemail dir (api with VOICEMAIL_DIR), after m1-t4.mjs.
// Usage: node scripts/e2e/m11-t5.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { launch } from './cdp.mjs';

const AST = 'sp-live-ast';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (cmd) =>
  spawnSync('docker', ['exec', AST, 'asterisk', '-rx', cmd], { encoding: 'utf8' }).stdout;
const [base, email, pw, shotsDir] = process.argv.slice(2);

// The receiver: keeps every POST; the first call.* event gets a 500.
const got = [];
let failedOnce = false;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const event = req.headers['x-selfphoneng-event'];
    if (!failedOnce && String(event).startsWith('call.')) {
      failedOnce = true;
      got.push({ event, failed: true, at: Date.now() });
      return res.writeHead(500).end();
    }
    got.push({ event, headers: req.headers, body, at: Date.now() });
    res.writeHead(204).end();
  });
});
await new Promise((r) => server.listen(18099, '127.0.0.1', r));
const hookUrl = 'http://127.0.0.1:18099/selfphoneng';

const withToken = (token, method, url, body) =>
  fetch(`${base}${url}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body && JSON.stringify(body),
  });
const until = async (what, ms, fn) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    assert.ok(Date.now() < end, `timed out: ${what}`);
    await sleep(500);
  }
};
const text = (p) => p.evaluate('document.body.innerText');

const p = await launch({ shotsDir });
try {
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname.startsWith('/admin')`, 'signed in');

  // API token, made in the browser.
  await p.goto(`${base}/admin/settings/tokens`);
  await p.waitFor(`document.body.innerText.includes('Create token')`, 'tokens tab');
  await p.fill('Token name', 'e2e script');
  await p.click('Create token');
  await p.waitFor(`!!document.querySelector('[aria-label="New token"]')`, 'token shown');
  const token = await p.evaluate(`document.querySelector('[aria-label="New token"]').innerText`);
  assert.match(token, /^sp_[A-Za-z0-9]{40}$/);
  await p.shot('m11-t5-01-token');
  let r = await withToken(token, 'POST', '/api/extensions', { number: '201', name: 'Ann Lee' });
  assert.equal(r.status, 201, `extension by token: ${r.status} ${await r.text()}`);
  assert.equal((await withToken(token, 'GET', '/api/api-tokens')).status, 403);
  console.log(
    'token: made in the browser, added 201 without cookie or CSRF header, no token admin',
  );

  // Webhook, added in the browser.
  await p.goto(`${base}/admin/settings/webhooks`);
  await p.waitFor(`document.body.innerText.includes('Add webhook')`, 'webhooks tab');
  await p.fill('Send events to', hookUrl);
  for (const ev of ['call.started', 'voicemail.new'])
    await p.evaluate(
      `[...document.querySelectorAll('label')].find((l) => l.innerText.trim() === '${ev}').querySelector('input').click()`,
    );
  await p.click('Add webhook');
  await p.waitFor(`document.body.innerText.includes('${hookUrl}')`, 'webhook listed');
  await p.click('Send test');
  await p.waitFor(`document.body.innerText.includes('Test failed')`, 'test refused');
  assert.match(await text(p), /private address/);
  assert.equal(got.length, 0);
  await p.evaluate(
    `[...document.querySelectorAll('label')].find((l) => l.innerText.includes('Allow addresses on private networks')).querySelector('input').click()`,
  );
  await until(
    'allowPrivate saved',
    5000,
    async () =>
      (await (await withToken(token, 'GET', '/api/settings')).json())['webhooks.allowPrivate'],
  );
  await p.click('Send test');
  await p.waitFor(
    `document.body.innerText.includes('Test sent: the server answered 204')`,
    'test ok',
  );
  await p.shot('m11-t5-02-webhook');
  const [hook] = (await (await withToken(token, 'GET', '/api/webhooks')).json()).items;
  assert.deepEqual(hook.events.sort(), ['call.ended', 'call.started', 'voicemail.new']);
  const checkSig = (g) => {
    const ts = g.headers['x-selfphoneng-timestamp'];
    assert.ok(Math.abs(Date.now() / 1000 - Number(ts)) < 300, 'fresh timestamp');
    assert.equal(
      g.headers['x-selfphoneng-signature'],
      `sha256=${createHmac('sha256', hook.secret).update(`${ts}.${g.body}`).digest('hex')}`,
      `signature of ${g.event}`,
    );
    const body = JSON.parse(g.body);
    assert.equal(body.event, g.event);
    return body;
  };
  checkSig(got[0]);
  console.log('webhook: private address refused until allowed, then a signed test arrived');

  // A real call: 201 has no phone, so voicemail answers.
  await until('mailbox 201 in Asterisk', 30_000, () => /201/.test(cli('voicemail show users')));
  got.length = 0;
  const t0 = Date.now();
  cli(
    'channel originate Local/201@sp-vm-direct application Playback silence/10&silence/5&tt-weasels',
  );
  const ok = (ev) => got.filter((g) => g.event === ev && !g.failed);
  await until('call.ended, voicemail.new and the retried call.started', 150_000, () =>
    ['call.started', 'call.ended', 'voicemail.new'].every((ev) => ok(ev).length),
  );
  const started = checkSig(ok('call.started')[0]);
  const ended = checkSig(ok('call.ended')[0]);
  const vm = checkSig(ok('voicemail.new')[0]);
  assert.equal(started.data.linkedid, ended.data.linkedid);
  assert.ok(ended.data.endedAt);
  assert.equal(vm.event, 'voicemail.new');
  assert.ok(vm.data.durationS >= 1, 'voicemail duration');
  const fail = got.find((g) => g.failed);
  assert.ok(fail, 'one POST failed');
  const retry = ok(fail.event)[0];
  const gap = (retry.at - fail.at) / 1000;
  assert.ok(gap >= 55 && gap < 80, `retried a minute later (${gap} s)`);
  console.log(
    `call: ${got
      .filter((g) => !g.failed)
      .map((g) => g.event)
      .join(', ')}, all signed; ` +
      `${fail.event} failed once, came again after ${Math.round(gap)} s (${Math.round((Date.now() - t0) / 1000)} s total)`,
  );

  // Revoke in the browser.
  await p.goto(`${base}/admin/settings/tokens`);
  await p.waitFor(`document.body.innerText.includes('e2e script')`, 'token listed');
  assert.match(await text(p), /last used \d/);
  await p.click('Revoke');
  await p.waitFor(`!!document.querySelector('dialog[open]')`, 'confirm');
  await p.click('Revoke', 'dialog[open]');
  await p.waitFor(`document.body.innerText.includes('No tokens.')`, 'revoked');
  assert.equal((await withToken(token, 'GET', '/api/extensions')).status, 401);
  console.log('token: revoked in the browser, then refused');
  console.log('M11-T5: PASS');
} finally {
  await p.close();
  server.close();
}
