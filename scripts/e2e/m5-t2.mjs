// SPDX-License-Identifier: AGPL-3.0-or-later
// M5-T2, the parts a script can check (apps/web/TESTING.md is the manual run in Chrome/Firefox):
// incoming call dialog, call waiting (answering the second call holds the first), hold/resume,
// DTMF, blind and attended transfer, and "Use here" moving the softphone to another tab.
// Run after m5-t1.mjs (same api, user web@example.com / extension 170, network already set up).
// Usage: node scripts/e2e/m5-t2.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { launch } from './cdp.mjs';
import { startPhones } from './phones.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const USER = { email: 'web@example.com', password: 'web-new-password-123' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...a) => spawnSync('docker', a, { encoding: 'utf8' }).stdout ?? '';
const cli = (cmd) => docker('exec', AST, 'asterisk', '-rx', cmd);
const astLog = () => docker('logs', AST);
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
  return {
    ext: number,
    password: (await api('GET', `/api/extensions/${e.id}/sip-credentials`)).password,
  };
};
const phones = startPhones({
  name: 'sp-live-phones-m5',
  net: NET,
  ast: AST,
  phones: [
    { ...(await desk('172', 'Pat Desk')), answer: 'auto', toneHz: 440 },
    { ...(await desk('173', 'Quinn Desk')), answer: 'auto', toneHz: 660 },
  ],
});

/** Channels as {name, state, bridge} from `core show channels concise`. */
const channels = () =>
  cli('core show channels concise')
    .split('\n')
    .filter((l) => l.startsWith('PJSIP/'))
    .map((l) => {
      const f = l.split('!');
      return { name: f[0], state: f[4], bridge: f[12] };
    });
const waitUntil = async (fn, what, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(250);
  }
  throw new Error(`timeout waiting for: ${what}`);
};
/** 172 and 173 talk to each other, and the browser is out of the call. */
const transferred = () => {
  const c = channels();
  const a = c.find((x) => x.name.startsWith('PJSIP/172-'));
  const b = c.find((x) => x.name.startsWith('PJSIP/173-'));
  return a?.bridge && a.bridge === b?.bridge && !c.some((x) => x.name.startsWith('PJSIP/170-web'));
};
const hangupAll = async () => {
  cli('channel request hangup all');
  await waitUntil(() => channels().length === 0, 'all calls ended');
  await sleep(500);
};
const mark = () => astLog().length;
const logSince = (at) => astLog().slice(at);

const args = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
];
const p = await launch({ shotsDir, args });
const status = (tab) =>
  tab.evaluate(`document.querySelector('[aria-label=Softphone] [role=status]')?.textContent`);
try {
  await waitUntil(
    () =>
      /172\/sip:.*Avail/.test(cli('pjsip show contacts')) &&
      /173\/sip:.*Avail/.test(cli('pjsip show contacts')),
    'desk phones registered',
    180_000,
  );

  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', USER.email);
  await p.fill('Password', USER.password);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/me'`, 'my phone');
  await p.click('Enable softphone');
  await p.waitFor(
    `document.querySelector('[aria-label=Softphone] [role=status]')?.textContent === 'Ready'`,
    'registered',
    15_000,
  );
  console.log('softphone ready');

  // 1. Incoming call: the dialog, Answer.
  cli('channel originate PJSIP/172 extension 170@sp-from-ext');
  await p.waitFor(
    `document.querySelector('dialog[open]')?.innerText.includes('Pat Desk')`,
    'incoming call dialog with the caller name',
    15_000,
  );
  await p.shot('m5-t2-01-incoming');
  await p.evaluate(
    `[...document.querySelectorAll('dialog[open] button')].find(b => b.textContent === 'Answer').click(), true`,
  );
  await p.waitFor(`document.body.innerText.includes('On call')`, 'answered');
  console.log('incoming dialog → answered');

  // 2. DTMF from the keypad reaches the other phone.
  await p.click('Keypad');
  await p.evaluate(
    `[...document.querySelectorAll('[aria-label="Send tones"] button')].find(b => b.textContent === '5').click(), true`,
  );
  await waitUntil(() => /DTMF.*5|5.*DTMF/i.test(phones.log('172')), 'DTMF 5 at 172', 5000);
  console.log('DTMF 5 received by 172');

  // 3. Hold / resume: Asterisk plays music on hold to 172 while held.
  let at = mark();
  await p.click('Hold');
  await p.waitFor(`document.body.innerText.includes('On hold')`, 'held in the UI');
  await waitUntil(() => /music on hold.*PJSIP\/172-/i.test(logSince(at)), 'MOH to 172', 5000);
  at = mark();
  await p.click('Resume');
  await waitUntil(
    () => /Stopped music on hold.*PJSIP\/172-/i.test(logSince(at)),
    'MOH stopped',
    5000,
  );
  console.log('hold → music on hold for 172; resume → stopped');

  // 4. Call waiting: 173 calls in; answering it holds 172.
  at = mark();
  cli('channel originate PJSIP/173 extension 170@sp-from-ext');
  await p.waitFor(
    `!document.querySelector('dialog[open]') && document.body.innerText.includes('Incoming call')`,
    'second call shows as a card, not the dialog',
    15_000,
  );
  await p.shot('m5-t2-02-waiting');
  await p.click('Answer');
  await waitUntil(() => /music on hold.*PJSIP\/172-/i.test(logSince(at)), '172 held', 8000);
  await p.waitFor(
    `document.body.innerText.includes('On hold') && document.body.innerText.includes('On call')`,
  );
  console.log('call waiting: answered 173, 172 on hold');
  await hangupAll();
  await p.waitFor(`!document.body.innerText.includes('On call')`, 'calls gone in the UI');

  // 5. Blind transfer: browser calls 172, transfers it to 173.
  await p.click('Keypad');
  await p.fill('Number to call', '172');
  await p.click('Call');
  await p.waitFor(`document.body.innerText.includes('On call')`, 'browser → 172 answered', 15_000);
  await p.click('Transfer');
  await p.fill('Transfer to', '173');
  await p.click('Transfer now');
  await waitUntil(transferred, 'blind transfer: 172 ↔ 173');
  await p.waitFor(`!document.body.innerText.includes('On call')`, 'browser left the call');
  console.log('blind transfer: 172 now talks to 173');
  await hangupAll();

  // 6. Attended transfer: browser calls 172, talks to 173 first, then completes.
  await p.fill('Number to call', '172');
  await p.click('Call');
  await p.waitFor(`document.body.innerText.includes('On call')`, 'browser → 172 answered', 15_000);
  await p.click('Transfer');
  await p.fill('Transfer to', '173');
  await p.click('Talk first');
  await p.waitFor(
    `[...document.querySelectorAll('button')].some(b => b.textContent === 'Complete transfer' && !b.disabled)`,
    'consult call to 173 answered',
    15_000,
  );
  await p.shot('m5-t2-03-consult');
  await p.click('Complete transfer');
  await waitUntil(transferred, 'attended transfer: 172 ↔ 173');
  console.log('attended transfer: 172 now talks to 173');
  await hangupAll();

  // 7. One tab only: a second tab sees "Active in another tab"; "Use here" moves it.
  const tab2 = await p.newTab(`${base}/me`);
  await tab2.waitFor(
    `document.querySelector('[aria-label=Softphone] [role=status]')?.textContent === 'Active in another tab'`,
    'second tab defers to the first',
    15_000,
  );
  await tab2.click('Use here');
  await tab2.waitFor(
    `document.querySelector('[aria-label=Softphone] [role=status]')?.textContent === 'Ready'`,
    'second tab registered',
    15_000,
  );
  assert.equal(await status(p), 'Active in another tab', 'first tab stepped down');
  assert.equal(cli('pjsip show contacts').match(/170-web\/sip:/g)?.length, 1, 'one registration');
  console.log('"Use here" moved the softphone to the second tab');
  await tab2.close();

  console.log('M5-T2 (softphone features): PASS');
} catch (e) {
  await p.shot('m5-t2-fail').catch(() => {});
  console.log(`FAIL: ${e.message}`);
  console.log(`browser errors: ${JSON.stringify(p.consoleErrors)}`);
  console.log(
    `172 log:\n${phones
      .log('172')
      .split('\n')
      .filter((l) => !/audio=/.test(l))
      .slice(-15)
      .join('\n')}`,
  );
  process.exitCode = 1;
} finally {
  await p.close();
  phones.stop();
}
