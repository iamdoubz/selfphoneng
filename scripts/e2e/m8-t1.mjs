// SPDX-License-Identifier: AGPL-3.0-or-later
// M8-T1 with real phones: a queue built in the UI, 3 callers waiting with 2 agents, one agent
// paused with *45550 and the other from the UI, the dashboard tile and the queue page following
// live, unpause → the longest waiting caller reaches the agent, a caller who waits past the
// limit goes to the timeout destination, one hangs up, and today's stats count it all.
// Agents 280/281 and the overflow phone 282 auto-answer (that is how *45 is dialed from them).
// Runs on m2-live, after m1-t4.mjs.
// Usage: node scripts/e2e/m8-t1.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { originate } from './ami.mjs';
import { launch } from './cdp.mjs';
import { startPhones } from './phones.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const MAX_WAIT = 20;
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
/** `core show channels concise`: name, application, bridge id. */
const channels = () =>
  cli('core show channels concise')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const f = l.split('!');
      return { name: f[0], app: f[5], callerId: f[7], bridge: f[12] };
    });
/**
 * A caller is a Local channel pair: ;1 runs Wait, ;2 runs the dialplan and is the one bridged,
 * with the agent's Local/<ext>@sp-queue-member;1 or (timeout destination) PJSIP/<ext> directly.
 */
const talkingTo = (n, caller) => {
  const mine = channels().filter(
    (c) => c.name.startsWith(`PJSIP/${n}-`) || c.name.startsWith(`Local/${n}@sp-queue-member-`),
  );
  const theirs = channels().filter((c) => c.callerId === caller && c.bridge);
  return mine.some((m) => m.bridge && theirs.some((t) => t.bridge === m.bridge && t !== m));
};
const queueShow = () => cli('queue show 550');

const people = [
  ['280', 'Ann Agent'],
  ['281', 'Bob Agent'],
  ['282', 'Olga Overflow'],
];
const phoneList = [];
for (const [ext, name] of people) {
  const e = await api('POST', '/api/extensions', { number: ext, name });
  const pass = (await api('GET', `/api/extensions/${e.id}/sip-credentials`)).password;
  phoneList.push({ ext, password: pass, answer: 'auto' });
}
const phones = startPhones({ name: 'sp-live-phones-m8t1', net: NET, ast: AST, phones: phoneList });

const p = await launch({ shotsDir });
const pick = (label, text) =>
  p.evaluate(`(() => {
    const s = [...document.querySelectorAll('select')].find(s => s.getAttribute('aria-label') === ${JSON.stringify(label)} || s.labels?.[0]?.textContent === ${JSON.stringify(label)});
    const o = [...s.options].find(o => o.textContent.includes(${JSON.stringify(text)}));
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, o.value);
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
const check = (text) =>
  p.evaluate(`(() => {
    const l = [...document.querySelectorAll('dialog[open] label')].find(l => l.textContent.includes(${JSON.stringify(text)}));
    const box = l.querySelector('input[type=checkbox]');
    if (!box.checked) box.click();
    return true;
  })()`);
const callers = ['3125550001', '3125550002', '3125550003'];
const call = (n) =>
  originate({
    Channel: 'Local/550@sp-from-ext',
    Application: 'Wait',
    Data: '90',
    CallerID: `"Caller ${n.slice(-1)}" <${n}>`,
  });

try {
  await waitUntil(
    () =>
      ['280', '281', '282'].every((e) =>
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

  // Build the queue in the UI.
  await p.click('Queues');
  await p.click('Add queue');
  await p.waitFor(`!!document.querySelector('dialog[open]')`);
  await p.waitFor(
    `[...document.querySelectorAll('dialog[open] label')].find(l => l.textContent === 'Number')?.control.value === '550'`,
    'next free queue number suggested',
  );
  await p.fill('Name', 'Support', 'dialog[open]');
  await pick('Add an agent', 'Ann Agent');
  await pick('Add an agent', 'Bob Agent');
  await p.fill('Longest wait (seconds)', String(MAX_WAIT), 'dialog[open]');
  const dest = 'When the wait is too long, the queue is full, or no agent is logged in';
  await pick(`${dest}: type`, 'Ring a user');
  await pick(`${dest}: user`, 'Olga Overflow');
  await check('Let callers wait even when no agent is logged in');
  await p.fill('Pause before trying the next agent (seconds)', '1', 'dialog[open]');
  await p.click('Save', 'dialog[open]');
  await p.waitFor(`document.body.innerText.includes('2 agents')`, 'saved');
  await waitUntil(
    () => /550 has 0 calls/.test(queueShow()) && /Local\/281@/.test(queueShow()),
    'queue 550 in Asterisk',
  );
  console.log('queue 550 created in the UI, loaded by app_queue with 280 and 281');
  const [q] = await api('GET', '/api/queues').then((r) => r.items);

  // *45550 from 280: logged out (paused) in app_queue, AstDB and PostgreSQL.
  let at = astLog().length;
  cli('channel originate PJSIP/280 extension *45550@sp-from-ext');
  await waitUntil(() => /Playing 'agent-loggedoff/.test(astLog().slice(at)), '*45 says logged off');
  await waitUntil(
    () => /Local\/280@sp-queue-member\/n.*\(paused/.test(queueShow()),
    '280 paused in app_queue',
  );
  assert.match(cli('database get SP QPAUSE/550/280'), /Value: 1/);
  const ann = (await api('GET', '/api/extensions')).items.find((e) => e.number === '280');
  await waitUntil(
    async () =>
      (await api('GET', `/api/queues/${q.id}`)).members.find((m) => m.extensionId === ann.id)
        .paused,
    '280 paused in the database',
  );
  console.log('*45550 from 280: paused in app_queue, AstDB and the database');

  // The queue's page: pause 281 there; both agents show Paused live.
  await p.click('Support');
  await p.waitFor(`location.pathname === '/admin/queues/${q.id}'`);
  await p.waitFor(
    `document.querySelector('ul[aria-label="Agents"]')?.innerText.includes('Paused')`,
    '280 paused on the page',
  );
  await p.click('Pause 281');
  await waitUntil(
    () => /Local\/281@sp-queue-member\/n.*\(paused/.test(queueShow()),
    '281 paused in app_queue',
  );
  await p.waitFor(
    `[...document.querySelectorAll('ul[aria-label="Agents"] li')].every(li => li.innerText.includes('Paused'))`,
    'both paused on the page',
  );
  console.log('281 paused from the UI');

  // Three callers wait.
  const t0 = Date.now();
  for (const n of callers) {
    await call(n);
    await sleep(2500);
  }
  await waitUntil(() => /550 has 3 calls/.test(queueShow()), '3 callers in app_queue');
  await p.waitFor(
    `document.querySelectorAll('ol[aria-label="Waiting callers"] li').length === 3`,
    '3 waiting on the page',
  );
  const order = await p.evaluate(
    `[...document.querySelectorAll('ol[aria-label="Waiting callers"] li')].map(li => li.innerText)`,
  );
  assert.ok(order[0].includes('Caller 1') && order[2].includes('Caller 3'), `order: ${order}`);
  await p.shot('m8-t1-01-waiting');
  console.log('3 callers waiting, in order, on the queue page');

  // The dashboard tile.
  await p.click('Dashboard');
  await p.waitFor(
    `document.querySelector('ul[aria-label="Queues"]')?.innerText.includes('3 waiting')`,
    'tile: 3 waiting',
  );
  const tile = await p.evaluate(`document.querySelector('ul[aria-label="Queues"]').innerText`);
  assert.match(tile, /0 of 2\s+agents free/, tile);
  await p.shot('m8-t1-02-dashboard');
  console.log(`dashboard tile: ${tile.replace(/\s+/g, ' ')}`);

  // Unpause 281 from the UI: the longest waiting caller (1) reaches 281.
  await p.goto(`${base}/admin/queues/${q.id}`);
  await p.waitFor(`!!document.querySelector('ul[aria-label="Agents"]')`);
  await p.click('Unpause 281');
  await waitUntil(() => talkingTo('281', callers[0]), 'caller 1 talking to 281', 20_000);
  await p.waitFor(
    `document.querySelectorAll('ol[aria-label="Waiting callers"] li').length === 2`,
    '2 waiting on the page',
  );
  console.log('unpaused 281 in the UI: caller 1 (longest waiting) now talks to 281');

  // Caller 3 gives up.
  const c3 = channels().find((c) => c.callerId === callers[2] && c.app === 'Wait');
  cli(`channel request hangup ${c3.name}`);
  await waitUntil(() => /550 has 1 call/.test(queueShow()), 'caller 3 gone', 10_000);

  // 281 is busy now; caller 2 waits out MAX_WAIT and goes to 282.
  await waitUntil(
    () => talkingTo('282', callers[1]),
    'caller 2 reaches 282',
    (MAX_WAIT + 15) * 1000,
  );
  const waited = (Date.now() - t0) / 1000 - 2.5;
  assert.ok(waited >= MAX_WAIT - 1, `caller 2 left after ${waited.toFixed(1)} s`);
  console.log(`caller 2 waited ${waited.toFixed(0)} s, then went to the timeout destination (282)`);

  await waitUntil(() => /550 has 0 calls/.test(queueShow()), 'queue empty', 15_000);
  cli('channel request hangup all');
  await waitUntil(() => channels().length === 0, 'calls ended');

  // *45550 again: 280 logs back in.
  at = astLog().length;
  cli('channel originate PJSIP/280 extension *45550@sp-from-ext');
  await waitUntil(() => /Playing 'agent-loginok/.test(astLog().slice(at)), '*45 says logged in');
  await waitUntil(
    () => !/Local\/280@sp-queue-member\/n.*\(paused/.test(queueShow()),
    '280 unpaused',
  );
  assert.match(cli('database get SP QPAUSE/550/280'), /not found/i);
  console.log('*45550 again: 280 logged back in');
  // Not an agent of 551: refused.
  at = astLog().length;
  cli('channel originate PJSIP/282 extension *45551@sp-from-ext');
  await waitUntil(() => /Playing 'ss-noservice/.test(astLog().slice(at)), '*45 refused');
  assert.match(cli('database get SP QPAUSE/551/282'), /not found/i);
  console.log('*45551 from a non-agent: refused, nothing stored');

  // Today's stats (calls are aggregated from CDRs a few seconds after they end).
  await sleep(1000);
  const s = await waitUntil(async () => {
    const r = await api('GET', `/api/queues/${q.id}/stats`);
    return r.offered === 3 && r;
  }, 'stats count 3 calls');
  assert.deepEqual(
    { answered: s.answered, abandoned: s.abandoned, timedOut: s.timedOut },
    { answered: 1, abandoned: 1, timedOut: 1 },
    JSON.stringify(s),
  );
  await p.goto(`${base}/admin/queues/${q.id}`);
  await p.waitFor(
    `document.querySelector('dl[aria-label="Today\\'s stats"]')?.innerText.includes('Timed out\\n1')`,
    'stats on the page',
  );
  await p.shot('m8-t1-03-stats');
  console.log(`stats: ${JSON.stringify(s)}`);
  console.log('M8-T1 (queues): PASS');
} catch (e) {
  await p.shot('m8-t1-fail').catch(() => {});
  console.log(`FAIL: ${e.message}`);
  console.log(`queue show: ${queueShow()}`);
  console.log(`browser errors: ${JSON.stringify(p.consoleErrors)}`);
  process.exitCode = 1;
} finally {
  cli('channel request hangup all');
  await p.close();
  phones.stop();
}
