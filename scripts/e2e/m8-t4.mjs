// SPDX-License-Identifier: AGPL-3.0-or-later
// M8-T4 with real calls: paging group 850 built in the UI (320, 321, 322). 320 and 321 are
// "intercom" desk phones: they ring like any phone (checked first), but answer by themselves when
// the INVITE carries the auto-answer headers, as Yealink and Grandstream phones do. 322 pages the
// group: 320 and 321 answer muted (one-way) and 322, already on the call, isn't paged. *80320 is
// a two-way intercom to 320; *80 with something that isn't a desk phone is refused.
// No real Yealink/Grandstream here: the hardware check stays open (09 M8-T4).
// Runs on m2-live, after m1-t4.mjs.
// Usage: node scripts/e2e/m8-t4.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { launch } from './cdp.mjs';
import { startPhones } from './phones.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (cmd) =>
  spawnSync('docker', ['exec', AST, 'asterisk', '-rx', cmd], { encoding: 'utf8' }).stdout ?? '';
const astLog = () =>
  // eslint-disable-next-line no-control-regex -- Asterisk colors its log
  spawnSync('docker', ['logs', AST], { encoding: 'utf8' }).stdout.replace(/\x1b\[[0-9;]*m/g, '');
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
const waitUntil = async (fn, what, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(300);
  }
  throw new Error(`timeout waiting for: ${what}`);
};
/** State of each PJSIP/<ext> channel: { '320': 'Up', ... }. */
const states = () =>
  Object.fromEntries(
    cli('core show channels concise')
      .split('\n')
      .filter((l) => l.startsWith('PJSIP/'))
      .map((l) => l.split('!'))
      .map((f) => [f[0].slice(6).split('-')[0], f[4]]),
  );
/** Paged participants (channel, flags) of every bridge Page() made. */
const paged = () =>
  [...cli('confbridge list').matchAll(/^(\S+)\s+\d+/gm)]
    .map((m) => m[1])
    .filter((c) => c !== 'Conference')
    .flatMap((room) =>
      cli(`confbridge list ${room}`)
        .split('\n')
        .filter((l) => /^PJSIP\//.test(l))
        .map((l) => ({ channel: l.split(/\s+/)[0], flags: l.split(/\s+/)[1] ?? '' })),
    );
/** INVITEs Asterisk sent to an extension since log offset `at`. */
const invitesTo = (ext, at) =>
  astLog()
    .slice(at)
    .split(/<--- Transmitting SIP request/)
    .filter((m) => new RegExp(`^[^\\n]*\\n+INVITE sip:${ext}[-@]`).test(m));

const phoneList = [];
const extIds = {};
for (const [ext, name, answer] of [
  ['320', 'Pat Page', 'manual'],
  ['321', 'Pia Page', 'manual'],
  ['322', 'Paul Pager', 'auto'],
]) {
  const e = await api('POST', '/api/extensions', { number: ext, name });
  extIds[ext] = e.id;
  const pass = (await api('GET', `/api/extensions/${e.id}/sip-credentials`)).password;
  phoneList.push({ ext, password: pass, answer, intercom: answer === 'manual' });
}
const phones = startPhones({ name: 'sp-live-phones-m8t4', net: NET, ast: AST, phones: phoneList });

const p = await launch({ shotsDir });
const check = (text) =>
  p.evaluate(`(() => {
    const l = [...document.querySelectorAll('dialog[open] label')].find(l => l.textContent.includes(${JSON.stringify(text)}));
    const box = l.querySelector('input[type=checkbox]');
    if (!box.checked) box.click();
    return true;
  })()`);
try {
  await waitUntil(
    () =>
      ['320', '321', '322'].every((e) =>
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

  // Group 850 in the UI.
  await p.click('Paging');
  await p.click('Add paging group');
  await p.waitFor(`!!document.querySelector('dialog[open]')`);
  await p.waitFor(
    `[...document.querySelectorAll('dialog[open] label')].find(l => l.textContent === 'Number')?.control.value === '850'`,
    'next free paging number suggested',
  );
  await p.fill('Name', 'Warehouse', 'dialog[open]');
  for (const ext of ['320', '321', '322']) await check(`${ext} `);
  await p.click('Save', 'dialog[open]');
  await p.waitFor(
    `document.body.innerText.includes('One-way: Pat Page, Pia Page, Paul Pager')`,
    'saved',
  );
  await waitUntil(
    () => /sp-page-/.test(cli('dialplan show 850@sp-local-numbers')),
    'dialplan has 850',
  );
  await p.shot('m8-t4-01-paging');
  console.log('paging group 850 built in the UI');

  // Control: an ordinary call to 320 rings and stays ringing.
  cli('channel originate PJSIP/322 extension 320@sp-from-ext');
  await waitUntil(() => states()['320'] === 'Ringing', '320 rings');
  await sleep(4000);
  assert.equal(states()['320'], 'Ringing', 'an ordinary call is not auto-answered');
  cli('channel request hangup all');
  await waitUntil(() => !Object.keys(states()).length, 'all hung up');
  console.log('ordinary call: 320 rings and does not answer by itself');

  // 322 pages 850: 320 and 321 answer by themselves, muted; 322 isn't paged.
  cli('pjsip set logger on');
  let at = astLog().length;
  cli('channel originate PJSIP/322 extension 850@sp-from-ext');
  await waitUntil(() => paged().length === 3, '322 + 320 + 321 in the page', 20_000);
  const s = states();
  assert.ok(s['320'] === 'Up' && s['321'] === 'Up', `states: ${JSON.stringify(s)}`);
  const inv = invitesTo('320', at);
  assert.equal(inv.length, 1, 'one INVITE to 320');
  assert.match(inv[0], /Call-Info: <sip:[^>]*>;answer-after=0/);
  assert.match(inv[0], /Alert-Info: info=alert-autoanswer/);
  assert.equal(invitesTo('322', at).length, 1, '322 only got the INVITE that started its call');
  const flags = Object.fromEntries(paged().map((m) => [m.channel.slice(6, 9), m.flags]));
  console.log(`page 850: flags ${JSON.stringify(flags)}`);
  assert.ok(/m/.test(flags['320']) && /m/.test(flags['321']), 'paged phones are muted');
  assert.ok(!/m/.test(flags['322'] ?? ''), 'the pager talks');
  console.log('page 850: 320 and 321 answered by themselves, muted; 322 (busy) skipped');
  cli('channel request hangup all');
  await waitUntil(() => !Object.keys(states()).length, 'all hung up');

  // *80320: two-way intercom.
  cli('channel originate PJSIP/322 extension *80320@sp-from-ext');
  await waitUntil(() => paged().length === 2, '322 + 320 in the intercom', 20_000);
  const iflags = Object.fromEntries(paged().map((m) => [m.channel.slice(6, 9), m.flags]));
  console.log(`*80320: flags ${JSON.stringify(iflags)}`);
  assert.ok(!/m/.test(iflags['320']), '320 can talk back');
  cli('channel request hangup all');
  await waitUntil(() => !Object.keys(states()).length, 'all hung up');
  console.log('*80320: 320 answered by itself and can talk back');

  // *80 to something that isn't a desk phone.
  at = astLog().length;
  cli('channel originate PJSIP/322 extension *80999@sp-from-ext');
  await waitUntil(() => /Playing 'ss-noservice/.test(astLog().slice(at)), '*80999 refused');
  console.log('*80999: refused (ss-noservice)');
  cli('pjsip set logger off');
  console.log('M8-T4 (paging): PASS');
} catch (e) {
  await p.shot('m8-t4-fail').catch(() => {});
  console.log(`FAIL: ${e.message}`);
  console.log(`confbridge: ${cli('confbridge list')}`);
  console.log(`channels: ${cli('core show channels concise')}`);
  console.log(`browser errors: ${JSON.stringify(p.consoleErrors)}`);
  process.exitCode = 1;
} finally {
  cli('pjsip set logger off');
  cli('channel request hangup all');
  await p.close();
  phones.stop();
}
