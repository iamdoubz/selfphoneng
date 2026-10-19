// SPDX-License-Identifier: AGPL-3.0-or-later
// M8-T2 with real phones: 290 answers a call and parks it (blind transfer to 700, as a phone's
// transfer key does), it lands on 701, the slot's BLF hint goes busy, the dashboard and a user's
// Home list it, and the user picks it up with "Pick up 701": their desk phone 291 rings, then
// dials 701 and talks to the caller. A second park takes 702 (findslot = next) and another
// phone (292) picks it up by dialing 702.
// Runs on m2-live, after m1-t4.mjs.
// Usage: node scripts/e2e/m8-t2.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { action, originate } from './ami.mjs';
import { launch } from './cdp.mjs';
import { startPhones } from './phones.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const PIA = { email: 'pia@example.com', password: 'pia-new-password-123' };
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
const channels = () =>
  cli('core show channels concise')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const f = l.split('!');
      return { name: f[0], app: f[5], callerId: f[7], bridge: f[12] };
    });
const chan = (n) => channels().find((c) => c.name.startsWith(`PJSIP/${n}-`));
/** The caller's bridged half (Local;2) shares a bridge with phone n. */
const talkingTo = (n, caller) => {
  const phone = chan(n);
  return (
    !!phone?.bridge &&
    channels().some((c) => c.callerId === caller && c !== phone && c.bridge === phone.bridge)
  );
};
const hint701 = () => /701@sp-parkedcalls.*State:(\w+)/.exec(cli('core show hint 701'))?.[1];
/** Occupied slot (findslot = next: each park takes the slot after the last one used). */
const parkedSlot = () =>
  /Space\s*:\s*(\d+)/.exec(cli('parking show default').split('Parked Calls')[1] ?? '')?.[1];
const parkedOn701 = () => parkedSlot() === '701';

const user = await api('POST', '/api/users', { email: PIA.email, displayName: 'Pia Picker' });
const people = [
  ['290', 'Paul Parker', null],
  ['291', 'Pia Picker', user.user.id],
  ['292', 'Gil Grab', null],
];
const phoneList = [];
for (const [ext, name, userId] of people) {
  const e = await api('POST', '/api/extensions', {
    number: ext,
    name,
    ...(userId ? { userId } : {}),
  });
  const pass = (await api('GET', `/api/extensions/${e.id}/sip-credentials`)).password;
  phoneList.push({ ext, password: pass, answer: 'auto' });
}
const phones = startPhones({ name: 'sp-live-phones-m8t2', net: NET, ast: AST, phones: phoneList });

/** A caller rings 290, who answers and blind-transfers it to 700. */
async function callAndPark(caller, slot = '701') {
  await originate({
    Channel: 'Local/290@sp-from-ext',
    Application: 'Wait',
    Data: '90',
    CallerID: `"Carla Caller" <${caller}>`,
  });
  await waitUntil(() => talkingTo('290', caller), '290 answers');
  await action({
    Action: 'BlindTransfer',
    Channel: chan('290').name,
    Context: 'sp-from-ext',
    Exten: '700',
  });
  await waitUntil(() => parkedSlot() === slot, `parked on ${slot}`);
  await waitUntil(() => !chan('290'), '290 hangs up after the transfer');
}

const admin = await launch({ shotsDir });
const pia = await launch({ shotsDir });
const ROW = `(document.querySelector('ul[aria-label="Parked calls"]')?.innerText ?? '')`;
const EMPTY = `document.body.innerText.includes('Transfer a call to 700 to park it')`;
try {
  await waitUntil(
    () =>
      ['290', '291', '292'].every((e) =>
        new RegExp(`${e}/sip:.*Avail`).test(cli('pjsip show contacts')),
      ),
    'phones',
    180_000,
  );
  await admin.goto(`${base}/login`);
  await admin.waitFor(`!!document.querySelector('input[type=email]')`);
  await admin.fill('Email', email);
  await admin.fill('Password', pw);
  await admin.click('Sign in');
  await admin.waitFor(`location.pathname === '/admin'`);
  await admin.waitFor(EMPTY, 'dashboard: no parked calls');

  await pia.goto(`${base}/login`);
  await pia.waitFor(`!!document.querySelector('input[type=email]')`);
  await pia.fill('Email', PIA.email);
  await pia.fill('Password', user.temporaryPassword);
  await pia.click('Sign in');
  await pia.waitFor(`location.pathname === '/change-password'`, 'forced password change');
  await pia.fill('Current password', user.temporaryPassword);
  await pia.fill('New password', PIA.password);
  await pia.fill('Repeat new password', PIA.password);
  await pia.click('Change password');
  await pia.waitFor(`location.pathname === '/me'`, 'my phone');

  // An empty slot's hint is Unavailable (BLF off), a parked call makes it InUse.
  assert.notEqual(hint701(), 'InUse', 'slot 701 free before');
  await callAndPark('3125550101');
  await waitUntil(() => hint701() === 'InUse', 'BLF hint 701 busy');
  console.log('290 parked the call on 701; hint 701@sp-parkedcalls is InUse');

  await admin.waitFor(
    `${ROW}.includes('701') && ${ROW}.includes('parked by 290')`,
    'dashboard 701',
  );
  assert.match(await admin.evaluate(ROW), /Carla Caller/);
  await admin.waitFor(
    `[...document.querySelectorAll('ul[aria-label="Calls now"] > li')].some(li => li.innerText.includes('Parked'))`,
    'the live call shows Parked',
  );
  await pia.waitFor(`${ROW}.includes('701')`, 'Home lists 701');
  await admin.shot('m8-t2-01-dashboard');
  await pia.shot('m8-t2-02-home');
  console.log('dashboard and Home list the parked call on 701 (Carla Caller, parked by 290)');

  // Pick up from Home: 291 rings (auto-answers), then dials 701.
  await pia.click('Pick up 701');
  await waitUntil(() => talkingTo('291', '3125550101'), '291 talks to the caller', 20_000);
  await waitUntil(() => !parkedOn701() && hint701() !== 'InUse', 'slot 701 free again');
  await pia.waitFor(EMPTY, 'Home list empties');
  await admin.waitFor(EMPTY, 'dashboard list empties');
  console.log('"Pick up 701" on Home: 291 rang, dialed 701 and talks to the caller; slot free');

  // Dialing the slot from another phone (the next park takes 702).
  cli('channel request hangup all');
  await waitUntil(() => channels().length === 0, 'calls ended');
  await callAndPark('3125550102', '702');
  cli('channel originate PJSIP/292 extension 702@sp-from-ext');
  await waitUntil(() => talkingTo('292', '3125550102'), '292 talks to the caller', 20_000);
  await waitUntil(() => !parkedSlot(), 'slot 702 free again');
  console.log('the next park took 702; dialing 702 from 292 picked it up');

  cli('channel request hangup all');
  console.log('M8-T2 (parking): PASS');
} catch (e) {
  await admin.shot('m8-t2-fail-admin').catch(() => {});
  await pia.shot('m8-t2-fail-user').catch(() => {});
  console.log(`FAIL: ${e.message}`);
  console.log(`parking: ${cli('parking show default')}`);
  console.log(`hint: ${cli('core show hint 701')}`);
  console.log(`browser errors: ${JSON.stringify([...admin.consoleErrors, ...pia.consoleErrors])}`);
  process.exitCode = 1;
} finally {
  cli('channel request hangup all');
  await admin.close();
  await pia.close();
  phones.stop();
}
