// SPDX-License-Identifier: AGPL-3.0-or-later
// The owner's follow-ups to M11-T7 (2026-10-20):
// - Users & Extensions → user → Calling → "Record calls": "Calls from outside" records a real
//   inbound call to that person (MixMonitor, a recording in call history); back to "Never", the
//   next call isn't recorded.
// - System page: a public IP change in Settings → Network raises the dashboard warning, its link
//   opens System ("Restart: Needed" and the command); running what it says (here `docker restart`
//   on the m2-live container, which is what `docker compose restart asterisk` does) brings it back
//   to "Running" and "Not needed", and the warning goes away. System information shows the IP and
//   ports, and the event log (and its CSV) has the restart: restart needed, Asterisk down, up.
// - About (no sign-in, linked from the login page): "Code v<version>" downloads selfphone.tar.gz,
//   byte for byte the archive the api image was built with.
// Runs on m2-live with a recordings dir (api with RECORDINGS_DIR), after m1-t4.mjs. The api's working
// directory <apiDir> holds VERSION and selfphone.tar.gz copied out of a built api image.
// Usage: node scripts/e2e/m11-system.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir> <apiDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { originate } from './ami.mjs';
import { launch } from './cdp.mjs';
import { startPhones } from './phones.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const DID = '13125558899';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (cmd) =>
  spawnSync('docker', ['exec', AST, 'asterisk', '-rx', cmd], { encoding: 'utf8' }).stdout ?? '';
// eslint-disable-next-line no-control-regex -- strips Asterisk's log colors
const ANSI = /\x1b\[[0-9;]*m/g;
const astLog = () =>
  (spawnSync('docker', ['logs', AST], { encoding: 'utf8' }).stdout ?? '').replace(ANSI, '');
const [base, email, pw, shotsDir, apiDir] = process.argv.slice(2);
const until = async (what, ms, fn) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    assert.ok(Date.now() < end, `timed out: ${what}`);
    await sleep(500);
  }
};

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
  const text = await r.text();
  assert.ok(r.ok, `${method} ${url}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
};

const { user } = await api('POST', '/api/users', {
  email: 'rita@example.com',
  displayName: 'Rita Recorded',
});
const ext = await api('POST', '/api/extensions', {
  number: '241',
  name: 'Rita Recorded',
  userId: user.id,
});
const pass = (await api('GET', `/api/extensions/${ext.id}/sip-credentials`)).password;
const trunk = await api('POST', '/api/trunks', {
  name: 'Recording test',
  serverHost: '127.0.0.1',
  username: 'm11rec',
  password: 'unused-password-1',
});
await api('POST', '/api/dids', {
  number: DID,
  trunkId: trunk.id,
  label: 'Rita direct',
  destination: { type: 'user', id: ext.id },
});
const phones = startPhones({
  name: 'sp-live-phones-m11sys',
  net: NET,
  ast: AST,
  phones: [{ ext: '241', password: pass, answer: 'auto' }],
});
/** One call from outside to Rita's number; true when Asterisk started recording it. */
const callIn = async (n) => {
  const at = astLog().length;
  await originate({
    Channel: `Local/${DID}@sp-from-trunk-${trunk.id}`,
    CallerID: `"Outside" <${n}>`,
    Application: 'Wait',
    Data: '20',
  });
  await until('241 rings', 20_000, () => /Called PJSIP\/241\//.test(astLog().slice(at)));
  await sleep(5000);
  cli('channel request hangup all');
  await sleep(2000);
  return /MixMonitor\(/.test(astLog().slice(at));
};

const p = await launch({ shotsDir });
try {
  await until('phone 241 registered', 180_000, () =>
    /241\/sip:.*Avail/.test(cli('pjsip show contacts')),
  );
  // About, before signing in: the login page links it, "Code v…" is this build's source.
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.evaluate(
    `[...document.querySelectorAll('a')].find(a => a.textContent.includes('source code')).click(), true`,
  );
  await p.waitFor(`location.pathname === '/about'`, 'about page');
  await p.waitFor(`document.body.innerText.includes('Code v')`, 'source button');
  const dl = await p.evaluate(`(async () => {
    const a = [...document.querySelectorAll('a')].find(a => a.textContent.startsWith('Code v'));
    const r = await fetch(a.href);
    const b = new Uint8Array(await r.arrayBuffer());
    return { text: a.textContent, download: a.getAttribute('download'), status: r.status,
      disposition: r.headers.get('content-disposition'), bytes: b.length, gzip: b[0] === 0x1f && b[1] === 0x8b };
  })()`);
  const archive = readFileSync(join(apiDir, 'selfphone.tar.gz'));
  assert.deepEqual(dl, {
    text: `Code v${readFileSync(join(apiDir, 'VERSION'), 'utf8').trim()}`,
    download: 'selfphone.tar.gz',
    status: 200,
    disposition: 'attachment; filename="selfphone.tar.gz"',
    bytes: archive.length,
    gzip: true,
  });
  await p.shot('m11-system-00-about');
  console.log(`about (signed out): "${dl.text}" downloads selfphone.tar.gz, ${dl.bytes} bytes`);

  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname.startsWith('/admin')`, 'signed in');

  // Record calls, set in the user drawer.
  const setRecord = async (value) => {
    await p.goto(`${base}/admin/users`);
    await p.waitFor(`document.body.innerText.includes('rita@example.com')`, 'users list');
    await p.click('Edit Rita Recorded');
    await p.waitFor(
      `[...document.querySelectorAll('[role=tab]')].some(t => t.textContent === 'Calling' && !t.disabled)`,
      'Calling tab',
    );
    await p.click('Calling');
    await p.waitFor(`!!document.querySelector('#user-calling-form')`, 'Calling form');
    await p.fill('Record calls', value);
    if (value !== 'never') await p.shot('m11-system-01-record-calls');
    await p.evaluate(
      `document.querySelector('dialog button[form=user-calling-form]').click(), true`,
    );
    await p.waitFor(`!document.querySelector('dialog[open]')`, 'drawer closed');
    await until(
      'record mode saved',
      10_000,
      async () => (await api('GET', `/api/extensions/${ext.id}`)).recordMode === value,
    );
    await until(
      `dialplan has ${value}`,
      30_000,
      () =>
        cli('dialplan show 241@sp-local-numbers').includes(`(241,`) &&
        cli('dialplan show 241@sp-local-numbers').includes(`,${value}))`),
    );
  };
  await setRecord('inbound');
  assert.ok(await callIn('3125550781'), 'the call was recorded');
  const call = await until('call with its recording in history', 60_000, async () => {
    const c = (await api('GET', '/api/calls?q=5558899')).items[0];
    return c?.recordingId ? c : null;
  });
  console.log(`record calls "Calls from outside": recorded (${call.talkSeconds} s, in history)`);
  await setRecord('never');
  assert.equal(await callIn('3125550782'), false, 'not recorded after "Never"');
  console.log('record calls "Never": the next call was not recorded');

  // A public IP change → warning → System page → restart → cleared.
  await p.goto(`${base}/admin/settings/network`);
  await p.waitFor(`!!document.querySelector('input')`, 'network tab');
  await p.fill('Public IP', '203.0.113.77');
  await p.click('Save');
  await p.waitFor(`document.body.innerText.includes('Saved.')`, 'saved');
  await until(
    'restart required',
    30_000,
    async () => (await api('GET', '/api/system/status')).restartRequired,
  );
  await p.goto(`${base}/admin`);
  await p.waitFor(
    `document.querySelector('[aria-label=Warnings]')?.innerText.includes('need a telephony restart')`,
    'dashboard warning',
  );
  await p.evaluate(
    `[...document.querySelectorAll('[aria-label=Warnings] li')].find(li => li.innerText.includes('telephony restart')).querySelector('a').click(), true`,
  );
  await p.waitFor(`location.pathname === '/admin/system'`, 'System page from the warning');
  await p.waitFor(
    `document.querySelector('[aria-label=Status]')?.innerText.includes('Needed')`,
    'restart needed',
  );
  const command = await p.evaluate(
    `document.querySelector('[aria-label="Restart command"]').innerText.trim()`,
  );
  assert.equal(command, 'docker compose restart asterisk');
  await p.shot('m11-system-02-needed');
  console.log(`system page: "Restart: Needed", tells to run: ${command}`);

  spawnSync('docker', ['restart', AST]);
  // Reloaded rather than waiting for the page's own 10 s refresh: headless tabs count as hidden,
  // and React Query pauses intervals in hidden tabs.
  await until('running and not needed after the restart', 90_000, async () => {
    await p.goto(`${base}/admin/system`);
    await p.waitFor(`!!document.querySelector('[aria-label=Status]')`, 'status');
    return /Running[\s\S]*Not needed/.test(
      await p.evaluate(`document.querySelector('[aria-label=Status]').innerText`),
    );
  });
  await p.shot('m11-system-03-restarted');
  assert.match(
    cli('pjsip show transport transport-udp'),
    /203\.0\.113\.77/,
    'new public IP in use',
  );
  const warnings = (await api('GET', '/api/system/warnings')).items.map((w) => w.code);
  assert.ok(!warnings.includes('restart_required'), `warnings: ${warnings}`);
  console.log('after the restart: "Running", "Not needed", the new IP in use, no warning');

  // System information and the event log: the restart above is in it.
  const info = await p.evaluate(`document.querySelector('[aria-label=Status]').innerText`);
  for (const want of ['Public IP', '203.0.113.77', 'SIP 5060', 'Media 10000–20000', 'HTTPS 443'])
    assert.ok(info.includes(want), `system information lacks ${want}:\n${info}`);
  await until('events in the log', 30_000, async () => {
    await p.goto(`${base}/admin/system`);
    await p.waitFor(`!!document.querySelector('[aria-label="Event log"]')`, 'event log');
    await sleep(1000);
    const codes = await p.evaluate(
      `[...document.querySelectorAll('[aria-label=Events] tbody tr')].map(r => r.cells[1].innerText)`,
    );
    return ['telephony.restartNeeded', 'telephony.down', 'telephony.up'].every((c) =>
      codes.includes(c),
    );
  });
  const csv = await p.evaluate(
    `fetch('/api/system/events.csv').then(async r => [r.status, r.headers.get('content-disposition'), await r.text()])`,
  );
  assert.equal(csv[0], 200);
  assert.match(csv[1], /selfphoneng-events\.csv/);
  assert.match(csv[2], /^time,severity,event,source,details\r\n/);
  assert.match(csv[2], /telephony\.down,Telephony/);
  await p.shot('m11-system-04-events');
  const narrow = await launch({ width: 390, height: 900, shotsDir });
  try {
    await narrow.goto(`${base}/login`);
    await narrow.waitFor(`!!document.querySelector('input[type=email]')`);
    await narrow.fill('Email', email);
    await narrow.fill('Password', pw);
    await narrow.click('Sign in');
    await narrow.waitFor(`location.pathname.startsWith('/admin')`, 'signed in (phone)');
    await narrow.goto(`${base}/admin/system`);
    await narrow.waitFor(`!!document.querySelector('[aria-label=Events]')`, 'events (phone)');
    assert.equal(
      await narrow.evaluate(
        'document.documentElement.scrollWidth > document.documentElement.clientWidth',
      ),
      false,
      'System page scrolls sideways at 390px',
    );
    await narrow.shot('m11-system-05-phone');
  } finally {
    await narrow.close();
  }
  console.log(
    'system information shows IP and ports; the event log has the restart (and its CSV); no sideways scroll at 390px',
  );
  console.log('M11 system page, about and record switch: PASS');
} finally {
  await p.close();
  phones.stop();
}
