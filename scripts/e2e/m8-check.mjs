// SPDX-License-Identifier: AGPL-3.0-or-later
// M8 milestone check (09 M8), as real calls from outside (into a trunk's entry context):
//   DID → queue 550 with agents 340 and 341, max wait 30 s, then 342. 340 pauses with *45550 and
//   341 is paused too, so 3 callers wait. 341 comes back and gets the longest waiting caller,
//   parks them (transfer to 700) on 701, and 343 picks them up by dialing 701. 341 is free again
//   and takes the next caller; the last one waits past 30 s and goes to 342. Today's stats agree.
// Phones (baresip, auto-answer): 340–343. Runs on m2-live after m1-t4.
// Usage: node scripts/e2e/m8-check.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { action, originate } from './ami.mjs';
import { startPhones } from './phones.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const DID = '13125558808';
const MAX_WAIT = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (cmd) =>
  spawnSync('docker', ['exec', AST, 'asterisk', '-rx', cmd], { encoding: 'utf8' }).stdout ?? '';
const astLog = () =>
  // eslint-disable-next-line no-control-regex -- Asterisk colors its log
  spawnSync('docker', ['logs', AST], { encoding: 'utf8' }).stdout.replace(/\x1b\[[0-9;]*m/g, '');
const [base, email, pw] = process.argv.slice(2);

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
      return { name: f[0], app: f[5], callerId: f[7], bridge: f[12] };
    });
const chan = (n) => channels().find((c) => c.name.startsWith(`PJSIP/${n}-`));
/** Phone n (directly, or as a queue agent's Local leg) shares a bridge with the caller (whose
 * number the trunk entry has normalized to 1NXX…). */
const talkingTo = (n, caller) => {
  const mine = channels().filter(
    (c) => c.name.startsWith(`PJSIP/${n}-`) || c.name.startsWith(`Local/${n}@sp-queue-member-`),
  );
  const theirs = channels().filter((c) => c.callerId?.endsWith(caller) && c.bridge);
  return mine.some((m) => m.bridge && theirs.some((t) => t.bridge === m.bridge && t !== m));
};
const queueShow = () => cli('queue show 550');
const parkedSlot = () =>
  /Space\s*:\s*(\d+)/.exec(cli('parking show default').split('Parked Calls')[1] ?? '')?.[1];

const ext = {};
const phoneList = [];
for (const [n, name] of [
  ['340', 'Ann Agent'],
  ['341', 'Bob Agent'],
  ['342', 'Olga Overflow'],
  ['343', 'Gil Grab'],
]) {
  const e = await api('POST', '/api/extensions', { number: n, name });
  ext[n] = e.id;
  const pass = (await api('GET', `/api/extensions/${e.id}/sip-credentials`)).password;
  phoneList.push({ ext: n, password: pass, answer: 'auto' });
}
const phones = startPhones({ name: 'sp-live-phones-m8chk', net: NET, ast: AST, phones: phoneList });
const queue = await api('POST', '/api/queues', {
  number: '550',
  name: 'Support',
  members: [
    { extensionId: ext['340'], penalty: 0 },
    { extensionId: ext['341'], penalty: 0 },
  ],
  maxWaitSeconds: MAX_WAIT,
  retrySeconds: 1,
  joinWhenNoAgents: true,
  timeoutDestination: { type: 'user', id: ext['342'] },
});
const trunk = await api('POST', '/api/trunks', {
  name: 'M8 check',
  serverHost: '127.0.0.1',
  username: 'm8check',
  password: 'unused-pw',
});
await api('POST', '/api/dids', {
  number: DID,
  trunkId: trunk.id,
  destination: { type: 'queue', id: queue.id },
});
const callers = ['3125550201', '3125550202', '3125550203'];
const inbound = (n) =>
  originate({
    Channel: `Local/${DID}@sp-from-trunk-${trunk.id}`,
    CallerID: `"Caller ${n.slice(-1)}" <${n}>`,
    Application: 'Wait',
    Data: '120',
  });

try {
  await waitUntil(
    () =>
      ['340', '341', '342', '343'].every((e) =>
        new RegExp(`${e}/sip:.*Avail`).test(cli('pjsip show contacts')),
      ),
    'phones',
    180_000,
  );
  await waitUntil(
    () => cli(`dialplan show ${DID}@sp-inbound`).includes('sp-queue-'),
    'DID routes to the queue',
  );

  // 340 pauses with *45550; 341 is paused by an admin, so nobody answers yet.
  const at = astLog().length;
  cli('channel originate PJSIP/340 extension *45550@sp-from-ext');
  await waitUntil(() => /Playing 'agent-loggedoff/.test(astLog().slice(at)), '*45 says logged off');
  await waitUntil(
    () => /Local\/340@sp-queue-member\/n.*\(paused/.test(queueShow()),
    '340 paused in app_queue',
  );
  await api('POST', `/api/queues/${queue.id}/members/${ext['341']}/pause`);
  await waitUntil(() => /Local\/341@sp-queue-member\/n.*\(paused/.test(queueShow()), '341 paused');
  await waitUntil(() => !chan('340'), '*45 call over');
  console.log('340 paused with *45550, 341 paused by an admin');

  // Three callers from outside wait.
  const joined = [];
  for (const n of callers) {
    await inbound(n);
    joined.push(Date.now());
    await sleep(2500);
  }
  await waitUntil(() => /550 has 3 calls/.test(queueShow()), '3 callers waiting');
  console.log('3 callers from the DID are waiting in queue 550 with 2 agents, both paused');

  // 341 is back: the longest waiting caller reaches 341.
  await api('POST', `/api/queues/${queue.id}/members/${ext['341']}/unpause`);
  await waitUntil(() => talkingTo('341', callers[0]), 'caller 1 talks to 341', 20_000);
  console.log('341 unpaused: caller 1 (longest waiting) talks to 341');

  // 341 parks caller 1 (blind transfer to 700, the phone's transfer key) and 343 picks up 701.
  await action({
    Action: 'BlindTransfer',
    Channel: chan('341').name,
    Context: 'sp-from-ext',
    Exten: '700',
  });
  await waitUntil(() => parkedSlot() === '701', 'caller 1 parked on 701');
  console.log('341 parked caller 1 on 701');
  cli('channel originate PJSIP/343 extension 701@sp-from-ext');
  await waitUntil(() => talkingTo('343', callers[0]), '343 talks to caller 1', 20_000);
  await waitUntil(() => !parkedSlot(), 'slot 701 free');
  console.log('343 dialed 701 and talks to caller 1');

  // 341 is free again: caller 2 reaches 341; caller 3 waits past the limit and goes to 342.
  await waitUntil(() => talkingTo('341', callers[1]), 'caller 2 talks to 341', 20_000);
  console.log('341 is free again: caller 2 talks to 341');
  await waitUntil(
    () => talkingTo('342', callers[2]),
    'caller 3 reaches 342',
    (MAX_WAIT + 15) * 1000,
  );
  const waited = (Date.now() - joined[2]) / 1000;
  assert.ok(waited >= MAX_WAIT - 1, `caller 3 left after ${waited.toFixed(1)} s`);
  console.log(`caller 3 waited ${waited.toFixed(0)} s (max ${MAX_WAIT}), then rang 342`);

  cli('channel request hangup all');
  await waitUntil(() => channels().length === 0, 'calls ended');
  const s = await waitUntil(async () => {
    const r = await api('GET', `/api/queues/${queue.id}/stats`);
    return r.offered === 3 && r;
  }, 'stats count 3 calls');
  assert.deepEqual(
    { answered: s.answered, abandoned: s.abandoned, timedOut: s.timedOut },
    { answered: 2, abandoned: 0, timedOut: 1 },
    JSON.stringify(s),
  );
  console.log(`stats: ${JSON.stringify(s)}`);
  console.log('M8 milestone check: PASS');
} catch (e) {
  console.log(`FAIL: ${e.message}`);
  console.log(`queue show: ${queueShow()}`);
  console.log(`parking: ${cli('parking show default')}`);
  console.log(`channels: ${cli('core show channels concise')}`);
  process.exitCode = 1;
} finally {
  cli('channel request hangup all');
  phones.stop();
}
