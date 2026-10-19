// SPDX-License-Identifier: AGPL-3.0-or-later
// M10-T4 with real phones: 380 calls 381; the admin (desk phone 382) presses Listen, then Whisper,
// then Barge on the dashboard. Each time 382 rings, answers, and Asterisk runs ChanSpy on the
// caller's leg with the mode's options (q, E, and w / B). When the call ends, the spy leg ends too.
// Runs on m2-live, after m1-t4.mjs.
// Usage: node scripts/e2e/m10-t4.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { launch } from './cdp.mjs';
import { startPhones } from './phones.mjs';

const NET = 'sp-live';
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
const waitUntil = async (fn, what, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(300);
  }
  throw new Error(`timeout waiting for: ${what}`);
};
const channels = () =>
  cli('core show channels concise')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const f = l.split('!');
      return { name: f[0], state: f[4], app: f[5], data: f[6] };
    });

const me = (await api('GET', '/api/auth/me')).user;
const phoneList = [];
for (const [n, name, userId] of [
  ['380', 'Cal Caller', null],
  ['381', 'Agent Ava', null],
  ['382', 'Boss Bo', me.id],
]) {
  const e = await api('POST', '/api/extensions', {
    number: n,
    name,
    ...(userId ? { userId } : {}),
  });
  const pass = (await api('GET', `/api/extensions/${e.id}/sip-credentials`)).password;
  phoneList.push({ ext: n, password: pass, answer: 'auto', toneHz: 300 + Number(n) });
}
const phones = startPhones({ name: 'sp-live-phones-m10t4', net: NET, ast: AST, phones: phoneList });

const p = await launch({ shotsDir });
const row = `[...document.querySelectorAll('ul[aria-label="Calls now"] > li')].find(li => li.innerText.includes('381'))`;
const press = (label) =>
  p.evaluate(`(() => {
    const b = [...${row}.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(label)});
    b.click();
    return true;
  })()`);
try {
  await waitUntil(
    () =>
      ['380', '381', '382'].every((e) =>
        new RegExp(`${e}/sip:.*Avail`).test(cli('pjsip show contacts')),
      ),
    'phones',
    180_000,
  );
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`);

  cli('channel originate PJSIP/380 extension 381@sp-from-ext');
  await p.waitFor(`!!${row}?.innerText.includes('Talking')`, 'call on the dashboard', 20_000);
  console.log('380 → 381 talking, on the dashboard');

  for (const [label, opts] of [
    ['Listen', 'qE'],
    ['Whisper', 'qEw'],
    ['Barge', 'qEB'],
  ]) {
    await press(label);
    const spyLeg = await waitUntil(
      () => channels().find((c) => c.name.startsWith('PJSIP/382-') && c.app === 'ChanSpy'),
      `${label}: 382 runs ChanSpy`,
    );
    assert.equal(spyLeg.state, 'Up');
    assert.match(spyLeg.data, new RegExp(`^PJSIP/38[01]-[0-9a-f]+,${opts}$`), spyLeg.data);
    await p.waitFor(
      `document.body.innerText.includes('Your desk phone is ringing')`,
      `${label}: status shown`,
    );
    if (label === 'Listen') await p.shot('m10-t4-01-listening');
    console.log(`${label}: 382 answered and runs ChanSpy(${spyLeg.data})`);
    if (label !== 'Barge') {
      cli(`channel request hangup ${spyLeg.name}`);
      await waitUntil(() => !channels().some((c) => c.name.startsWith('PJSIP/382-')), 'spy off');
    }
  }

  // The call ends: the spy leg (E) goes with it.
  const caller = channels().find((c) => c.name.startsWith('PJSIP/380-'));
  cli(`channel request hangup ${caller.name}`);
  await waitUntil(
    () => !channels().some((c) => c.name.startsWith('PJSIP/382-')),
    'spy ends',
    15_000,
  );
  console.log('the call ended and the barge leg ended with it');
  console.log('M10-T4 (listen, whisper, barge): PASS');
} catch (e) {
  await p.shot('m10-t4-fail').catch(() => {});
  console.log(`FAIL: ${e.message}`);
  console.log(`channels: ${cli('core show channels concise')}`);
  console.log(`browser errors: ${JSON.stringify(p.consoleErrors)}`);
  process.exitCode = 1;
} finally {
  cli('channel request hangup all');
  await p.close();
  phones.stop();
}
