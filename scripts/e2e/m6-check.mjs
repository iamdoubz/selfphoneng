// SPDX-License-Identifier: AGPL-3.0-or-later
// M6 milestone check (09 M6), as real calls into a trunk's entry context:
//   DID → office hours (open) → menu "1 sales (ring group, everyone at once), 2 support (102)";
//   closed → voicemail of 101; *311 from an admin's phone forces open; a blocked caller is
//   rejected. The blocked number is added in the UI (M6-T8).
// Phones (baresip, auto-answer): 220 (an admin's), 221, 222, 223. Runs on m2-live after m1-t4.
// Usage: node scripts/e2e/m6-check.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Socket } from 'node:net';
import { launch } from './cdp.mjs';
import { startPhones } from './phones.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const DID = '13125557777';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (cmd) =>
  spawnSync('docker', ['exec', AST, 'asterisk', '-rx', cmd], { encoding: 'utf8' }).stdout ?? '';
// eslint-disable-next-line no-control-regex -- strips Asterisk's log colors
const ANSI = /\x1b\[[0-9;]*m/g;
const astLog = () =>
  (spawnSync('docker', ['logs', AST], { encoding: 'utf8' }).stdout ?? '').replace(ANSI, '');
const [base, email, pw, shotsDir] = process.argv.slice(2);

/** One AMI Originate with a caller ID (the CLI can't set one). */
function originate(fields) {
  return new Promise((resolve, reject) => {
    const s = new Socket();
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (d) => {
      buf += d;
      if (/Response: Error/.test(buf)) reject(new Error(buf));
      if (/ActionID: o1[\s\S]*\r\n\r\n/.test(buf)) {
        s.end();
        resolve();
      }
    });
    s.on('error', reject);
    s.connect(15038, '127.0.0.1', () => {
      const lines = Object.entries({
        ...fields,
        Action: 'Originate',
        Async: 'true',
        ActionID: 'o1',
      })
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
      s.write(
        `Action: Login\r\nUsername: selfphoneng\r\nSecret: m2-live-secret\r\nEvents: off\r\n\r\n${lines}\r\n\r\n`,
      );
    });
  });
}

const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-requested-with': 'selfphoneng' },
  body: JSON.stringify({ email, password: pw }),
});
const cookie = login.headers
  .getSetCookie()
  .map((c) => c.split(';')[0])
  .join('; ');
const api = async (method, url, body, raw) => {
  const r = await fetch(`${base}${url}`, {
    method,
    headers: raw
      ? { 'content-type': 'audio/wav', 'x-requested-with': 'selfphoneng', cookie }
      : { 'content-type': 'application/json', 'x-requested-with': 'selfphoneng', cookie },
    body: raw ?? (body && JSON.stringify(body)),
  });
  const json = await r.json();
  assert.ok(r.ok, `${method} ${url}: ${r.status} ${JSON.stringify(json)}`);
  return json;
};
const next = async (kind) => (await api('GET', `/api/numbering/next?kind=${kind}`)).number;

// People and phones.
const boss = await api('POST', '/api/users', {
  email: 'boss@example.com',
  displayName: 'Bo Boss',
  role: 'admin',
});
const ext = {};
const pass = {};
for (const [n, name, extra] of [
  ['220', 'Bo Boss', { userId: boss.user.id }],
  ['221', 'Sal Sales'],
  ['222', 'Sam Sales'],
  ['223', 'Sue Support'],
]) {
  ext[n] = (await api('POST', '/api/extensions', { number: n, name, ...extra })).id;
  pass[n] = (await api('GET', `/api/extensions/${ext[n]}/sip-credentials`)).password;
}
const phones = startPhones({
  name: 'sp-live-phones-m6check',
  net: NET,
  ast: AST,
  phones: ['220', '221', '222', '223'].map((n, i) => ({
    ext: n,
    password: pass[n],
    answer: 'auto',
    toneHz: 440 + 110 * i,
  })),
});

// The call flow.
const wav = (() => {
  const n = 8000 * 3;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 500 * i) / 8000) * 8000), 44 + i * 2);
  return b;
})();
const greeting = await api('POST', '/api/sounds?name=Welcome%20menu', undefined, wav);
const sales = await api('POST', '/api/ring-groups', {
  number: await next('ringGroup'),
  name: 'Check sales',
  memberIds: [ext['221'], ext['222']],
  noAnswerDestination: { type: 'voicemail', id: ext['220'] },
});
const menu = await api('POST', '/api/ivrs', {
  number: await next('ivr'),
  name: 'Check menu',
  greetingSoundId: greeting.id,
  options: [
    { digit: '1', destination: { type: 'ring_group', id: sales.id } },
    { digit: '2', destination: { type: 'user', id: ext['223'] } },
  ],
  timeoutDestination: { type: 'voicemail', id: ext['220'] },
  invalidDestination: { type: 'voicemail', id: ext['220'] },
});
const used = new Set((await api('GET', '/api/time-conditions')).items.map((t) => t.overrideDigit));
const digit = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((d) => !used.has(d));
const hours = await api('POST', '/api/time-conditions', {
  name: 'Check hours',
  openRanges: [], // never open by the clock: overrides decide, so the check doesn't depend on now
  overrideDigit: digit,
  openDestination: { type: 'ivr', id: menu.id },
  closedDestination: { type: 'voicemail', id: ext['220'] },
});
const trunk = await api('POST', '/api/trunks', {
  name: 'M6 check',
  serverHost: '127.0.0.1',
  username: 'm6check',
  password: 'unused-pw',
});
await api('POST', '/api/dids', {
  number: DID,
  trunkId: trunk.id,
  destination: { type: 'time_condition', id: hours.id },
});

const waitUntil = async (fn, what, ms = 25_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(200);
  }
  throw new Error(`timeout waiting for: ${what}`);
};
const hangupAll = async () => {
  cli('channel request hangup all');
  await waitUntil(() => !/(PJSIP|Local)\//.test(cli('core show channels concise')), 'calls ended');
  await sleep(500);
};
/** A caller from outside: into the trunk's entry, presses `keys` once the greeting plays. */
async function inbound(from, keys = '') {
  const at = astLog().length;
  await originate({
    Channel: `Local/${DID}@sp-from-trunk-${trunk.id}`,
    CallerID: `"Outside" <${from}>`,
    Application: keys ? 'SendDTMF' : 'Wait',
    Data: keys ? `${'w'.repeat(10)}${keys}${'w'.repeat(40)}` : '25',
  });
  return () => astLog().slice(at);
}
const dialCode = async (code) => {
  cli(`channel originate PJSIP/220 extension ${code}@sp-from-ext`);
  await sleep(3000);
  await hangupAll();
};

const p = await launch({ shotsDir });
try {
  await waitUntil(
    () =>
      ['220', '221', '222', '223'].every((n) =>
        new RegExp(`${n}/sip:.*Avail`).test(cli('pjsip show contacts')),
      ),
    'phones registered',
    180_000,
  );
  await waitUntil(
    () => cli(`dialplan show ${DID}@sp-inbound`).includes('sp-tc-'),
    'dialplan ready',
  );

  // Closed (no hours, no override): straight to 220's voicemail.
  let log = await inbound('3125550111');
  await waitUntil(() => /VoiceMail\("[^"]+", "220@default,u"\)/.test(log()), 'closed → voicemail');
  await hangupAll();
  console.log('closed: the DID went to voicemail of 220');

  // *31N from the admin's phone forces open → menu → 1 = sales (221 and 222 ring together).
  await dialCode(`*31${digit}`);
  await waitUntil(
    async () => (await api('GET', `/api/time-conditions/${hours.id}`)).overrideState === 'open',
    'forced open',
  );
  log = await inbound('3125550111', '1');
  await waitUntil(
    () => /Called PJSIP\/221\//.test(log()) && /Called PJSIP\/222\//.test(log()),
    'sales rings',
  );
  assert.match(log(), new RegExp(`Playing '${greeting.asteriskName}\\.`), 'menu greeting played');
  await hangupAll();
  log = await inbound('3125550111', '2');
  await waitUntil(() => /Called PJSIP\/223\//.test(log()), 'support rings');
  await hangupAll();
  console.log(`*31${digit} forced open: menu greeting, 1 → 221 + 222 together, 2 → 223`);

  // Block the caller in the UI: the next call is rejected before anything rings.
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`);
  await p.click('Blocked numbers');
  await p.fill('Number to block', '(312) 555-0111');
  await p.fill('Note (optional)', 'Test spammer');
  await p.click('Block');
  await p.waitFor(`document.body.innerText.includes('(312) 555-0111')`, 'listed');
  await p.shot('m6-check-01-blocked');
  assert.match(cli('database show SP'), /\/SP\/BLOCK\/13125550111\s*:\s*1/);
  log = await inbound('3125550111', '1');
  await waitUntil(() => /Hangup\("[^"]+", "21"\)/.test(log()), 'blocked caller rejected');
  assert.doesNotMatch(log(), /Called PJSIP\//);
  await hangupAll();
  log = await inbound('3125550222', '2');
  await waitUntil(() => /Called PJSIP\/223\//.test(log()), 'other callers still get through');
  await hangupAll();
  console.log('blocked in the UI: (312) 555-0111 rejected (cause 21); others still get through');

  await dialCode(`*33${digit}`);
  await waitUntil(
    async () => (await api('GET', `/api/time-conditions/${hours.id}`)).overrideState === null,
    'automatic',
  );
  console.log('M6 milestone check: PASS');
} catch (e) {
  await p.shot('m6-check-fail').catch(() => {});
  console.log(`FAIL: ${e.message}`);
  process.exitCode = 1;
} finally {
  await p.close();
  phones.stop();
}
