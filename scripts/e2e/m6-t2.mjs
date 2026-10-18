// SPDX-License-Identifier: AGPL-3.0-or-later
// M6-T2 in a browser + real calls: create ring group 500 in the UI with members 190 (never
// answers) and 191 (auto-answer); a call from 192 is answered by 191. Then switch it to "one at a
// time" with 190 first: 190 rings alone for 5 s, then 191 rings and answers.
// Runs on the m2-live setup after m1-t4.mjs.
// Usage: node scripts/e2e/m6-t2.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { launch } from './cdp.mjs';
import { startPhones } from './phones.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (cmd) =>
  spawnSync('docker', ['exec', AST, 'asterisk', '-rx', cmd], { encoding: 'utf8' }).stdout ?? '';
const astLog = () => spawnSync('docker', ['logs', AST], { encoding: 'utf8' }).stdout ?? '';
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
    headers: { 'content-type': 'application/json', 'x-requested-with': 'selfphoneng', cookie },
    body: body && JSON.stringify(body),
  });
  const json = await r.json();
  assert.ok(r.ok, `${method} ${url}: ${r.status} ${JSON.stringify(json)}`);
  return json;
};
const desk = async (number, name) => {
  const e = await api('POST', '/api/extensions', { number, name });
  return (await api('GET', `/api/extensions/${e.id}/sip-credentials`)).password;
};
const phones = startPhones({
  name: 'sp-live-phones-m6t2',
  net: NET,
  ast: AST,
  phones: [
    { ext: '190', password: await desk('190', 'Nora Never'), answer: 'manual' },
    { ext: '191', password: await desk('191', 'Abe Answer'), answer: 'auto' },
    { ext: '192', password: await desk('192', 'Cal Caller'), answer: 'auto', toneHz: 660 },
  ],
});

const channels = () =>
  cli('core show channels concise')
    .split('\n')
    .filter((l) => l.startsWith('PJSIP/'))
    .map((l) => {
      const f = l.split('!');
      return { name: f[0], state: f[4], bridge: f[12], seq: Number(f[13]?.split('.')[1]) };
    });
const chan = (n) => channels().find((c) => c.name.startsWith(`PJSIP/${n}-`));
const waitUntil = async (fn, what, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timeout waiting for: ${what}`);
};
const hangupAll = async () => {
  cli('channel request hangup all');
  await waitUntil(() => channels().length === 0, 'calls ended');
  await sleep(500);
};
const pick = (label, text) =>
  p.evaluate(`(() => {
    const s = [...document.querySelectorAll('select')].find(s => s.getAttribute('aria-label') === ${JSON.stringify(label)} || s.labels?.[0]?.textContent === ${JSON.stringify(label)});
    const o = [...s.options].find(o => o.textContent.includes(${JSON.stringify(text)}));
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, o.value);
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);

const p = await launch({ shotsDir });
try {
  await waitUntil(
    () =>
      ['190', '191', '192'].every((n) =>
        new RegExp(`${n}/sip:.*Avail`).test(cli('pjsip show contacts')),
      ),
    'phones registered',
    180_000,
  );
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`);
  await p.click('Ring groups');
  await p.click('Add ring group');
  await p.waitFor(`!!document.querySelector('dialog[open]')`);
  await p.waitFor(
    `[...document.querySelectorAll('dialog[open] label')].find(l => l.textContent === 'Number')?.control.value === '500'`,
    'next free number suggested',
  );
  await p.fill('Name', 'Sales', 'dialog[open]');
  await pick('Add a member', 'Nora Never');
  await pick('Add a member', 'Abe Answer');
  await p.click('Save', 'dialog[open]');
  await p.waitFor(
    `document.body.innerText.includes('Everyone at once: Nora Never, Abe Answer')`,
    'saved',
  );
  await p.shot('m6-t2-01-list');
  await waitUntil(
    () => /Goto\(sp-rg-/.test(cli('dialplan show 500@sp-local-numbers')),
    'dialplan has 500',
  );
  console.log('ring group 500 created in the UI');

  // Everyone at once: 190 and 191 ring together; 191 answers. It answers within milliseconds,
  // so who was rung comes from Asterisk's log rather than the channel list.
  const at = astLog().length;
  cli('channel originate PJSIP/192 extension 500@sp-from-ext');
  await waitUntil(
    () => chan('191')?.bridge && chan('191').bridge === chan('192')?.bridge,
    '191 answers',
  );
  const rung = astLog().slice(at);
  assert.match(rung, /Called PJSIP\/190\//, '190 rang');
  assert.match(rung, /Called PJSIP\/191\//, '191 rang');
  await waitUntil(() => !chan('190'), '190 stops ringing');
  console.log('ring all: 190 and 191 rang together, 191 answered, 190 stopped');
  await hangupAll();

  // One at a time, 190 first for 5 s.
  await p.click('Edit');
  await p.waitFor(`!!document.querySelector('dialog[open]')`);
  await pick('How to ring', 'One at a time');
  await p.fill('Ring for (seconds)', '5', 'dialog[open]');
  await p.click('Save', 'dialog[open]');
  await p.waitFor(
    `document.body.innerText.includes('One at a time: Nora Never, Abe Answer')`,
    'saved hunt',
  );
  await waitUntil(
    () =>
      /,5,t\)/.test(
        cli(
          'dialplan show s@' +
            cli('dialplan show 500@sp-local-numbers').match(/sp-rg-[0-9a-f-]+/)[0],
        ),
      ),
    'hunt dialplan',
  );
  cli('channel originate PJSIP/192 extension 500@sp-from-ext');
  const t0 = Date.now();
  await waitUntil(() => chan('190'), '190 rings first');
  assert.equal(chan('191'), undefined, '191 does not ring yet');
  await waitUntil(() => chan('191'), '191 rings after 190', 10_000);
  const waited = (Date.now() - t0) / 1000;
  assert.ok(waited >= 4, `191 rang after ${waited.toFixed(1)} s`);
  await waitUntil(
    () => chan('191')?.bridge && chan('191').bridge === chan('192')?.bridge,
    '191 answers',
  );
  console.log(`one at a time: 190 alone, then 191 after ${waited.toFixed(1)} s and answered`);
  await hangupAll();

  console.log('M6-T2 (ring groups): PASS');
} catch (e) {
  await p.shot('m6-t2-fail').catch(() => {});
  console.log(`FAIL: ${e.message}`);
  process.exitCode = 1;
} finally {
  await p.close();
  phones.stop();
}
