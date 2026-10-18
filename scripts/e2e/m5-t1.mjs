// SPDX-License-Identifier: AGPL-3.0-or-later
// M5-T1 in a browser: the softphone registers (pjsip show contacts has 170-web) and calls between
// the browser and a "desk phone" (baresip, 171) have two-way audio, outgoing and incoming.
// Runs on the m2-live setup (after m1-t4.mjs), api started with WEBRTC_WS_URL=ws://127.0.0.1:18088/ws.
// The browser runs on the host, so the api is told LAN IP = the container, public IP = 127.0.0.1:
// Asterisk then offers 127.0.0.1 as an ICE candidate, which reaches it through the published
// RTP range. The real LAN/hotspot check needs the owner's server and a phone (09 M5-T1).
// Usage: node scripts/e2e/m5-t1.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './cdp.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const PHONE = 'sp-live-phone171';
const USER = { email: 'web@example.com', password: 'web-new-password-123' };
const SECONDS = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...a) => {
  const r = spawnSync('docker', a, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const cli = (cmd) => docker('exec', AST, 'asterisk', '-rx', cmd).out;
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

const astIp = docker(
  'inspect',
  '-f',
  `{{(index .NetworkSettings.Networks "${NET}").IPAddress}}`,
  AST,
).out.trim();
await api('PATCH', '/api/settings', { 'network.lanIp': astIp, 'network.publicIp': '127.0.0.1' });
// New transport settings need an Asterisk restart (01 §4.3); until then pjsip isn't reloaded.
await sleep(1500); // let the debounced apply mark the restart as required
await api('POST', '/api/system/asterisk/restart?now=true', {});
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const s = await api('GET', '/api/system/status').catch(() => null);
  if (s?.ami.connected && !s.restartRequired) break;
}
assert.equal((await api('GET', '/api/system/status')).restartRequired, false, 'restarted');
const created = await api('POST', '/api/users', { email: USER.email, displayName: 'Wen Browser' });
await api('POST', '/api/extensions', {
  number: '170',
  name: 'Wen Browser',
  userId: created.user.id,
});
const desk = await api('POST', '/api/extensions', { number: '171', name: 'Desk Phone' });
const creds = await api('GET', `/api/extensions/${desk.id}/sip-credentials`);

// The desk phone: auto-answers and "talks" (a 440 Hz tone).
const dir = mkdtempSync(join(tmpdir(), 'sp-phone171-'));
mkdirSync(join(dir, 'p'));
writeFileSync(
  join(dir, 'p', 'config'),
  'sip_listen 0.0.0.0:5076\nmodule_path /usr/lib/baresip/modules\nmodule g711.so\nmodule ausine.so\nmodule aufile.so\nmodule menu.so\nmodule account.so\naudio_source ausine,440\nausrc_srate 48000\nauplay_srate 48000\naudio_player aufile,/dev/null\naudio_alert aufile,/dev/null\nrtp_ports 30000-30100\n',
);
writeFileSync(
  join(dir, 'p', 'accounts'),
  `<sip:171@${AST};transport=udp>;auth_pass=${creds.password};answermode=auto;audio_codecs=PCMU\n`,
);
docker('rm', '-f', PHONE);
assert.ok(
  docker(
    'run',
    '-d',
    '--rm',
    '--name',
    PHONE,
    '--network',
    NET,
    '-v',
    `${dir}:/phone`,
    'debian:trixie-slim',
    'sh',
    '-c',
    'apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends baresip-core >/dev/null 2>&1 && baresip -f /phone/p > /phone/p/log 2>&1',
  ).ok,
);

/** RTP packets Asterisk received from / sent to each side of the current call. */
function audio() {
  const out = {};
  for (const line of cli('pjsip show channelstats').split('\n')) {
    const m = /\b(170-web|171)-[0-9a-f]+\b/.exec(line);
    if (!m) continue;
    const cols = line.trim().split(/\s+/);
    // BridgeId ChannelId UpTime Codec RxCount RxLost RxPct RxJitter TxCount ...
    out[m[1]] = { codec: cols[3], rx: Number(cols[4]), tx: Number(cols[8]) };
  }
  return out;
}
function assertTwoWay(what) {
  const a = audio();
  for (const side of ['170-web', '171']) {
    const s = a[side];
    assert.ok(s, `${what}: no ${side} channel in channelstats`);
    // 50 packets/s; ask for half of that, both ways.
    assert.ok(s.rx > SECONDS * 25 && s.tx > SECONDS * 25, `${what}: ${side} ${JSON.stringify(s)}`);
  }
  console.log(`${what}: two-way audio ${JSON.stringify(a)}`);
}
const hangupAll = async () => {
  cli('channel request hangup all');
  for (let i = 0; i < 20 && /PJSIP\//.test(cli('core show channels concise')); i++)
    await sleep(250);
};

const p = await launch({
  shotsDir,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
try {
  for (let i = 0; i < 180 && !/171\/sip:.*Avail/.test(cli('pjsip show contacts')); i++)
    await sleep(1000);
  assert.match(cli('pjsip show contacts'), /171\/sip:.*Avail/, 'desk phone registered');

  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', USER.email);
  await p.fill('Password', created.temporaryPassword);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/change-password'`, 'forced password change');
  await p.fill('Current password', created.temporaryPassword);
  await p.fill('New password', USER.password);
  await p.fill('Repeat new password', USER.password);
  await p.click('Change password');
  await p.waitFor(`location.pathname === '/me'`, 'my phone');

  await p.click('Enable softphone');
  await p.waitFor(
    `document.querySelector('[aria-label=Softphone] [role=status]')?.textContent === 'Ready'`,
    'softphone registered',
    15_000,
  );
  assert.match(cli('pjsip show contacts'), /170-web\/sip:/, 'pjsip show contacts has 170-web');
  console.log('browser registered as 170-web');
  await p.shot('m5-t1-01-ready');

  // Browser → desk phone.
  await p.click('Keypad');
  await p.fill('Number to call', '171');
  await p.click('Call');
  await p.waitFor(`document.body.innerText.includes('On call')`, 'outgoing call answered', 15_000);
  await sleep(SECONDS * 1000);
  await p.shot('m5-t1-02-outgoing');
  assertTwoWay('browser → desk');
  await p.click('Hang up');
  await p.waitFor(`!document.body.innerText.includes('On call')`, 'hung up');
  await hangupAll();

  // Desk phone → browser: 171 picks up (auto-answer), then the dialplan rings 170 (the browser).
  cli(`channel originate PJSIP/171 extension 170@sp-from-ext`);
  await p.waitFor(`document.body.innerText.includes('Incoming call')`, 'incoming call', 15_000);
  await p.shot('m5-t1-03-incoming');
  await p.click('Answer');
  await p.waitFor(`document.body.innerText.includes('On call')`, 'incoming answered', 10_000);
  await sleep(SECONDS * 1000);
  assertTwoWay('desk → browser');
  await p.click('Hang up');
  await p.waitFor(`!document.body.innerText.includes('On call')`, 'hung up');
  await hangupAll();

  console.log('M5-T1 (browser softphone, Docker): PASS');
} catch (e) {
  await p.shot('m5-t1-fail').catch(() => {});
  console.log(`FAIL: ${e.message}`);
  console.log(`browser console errors: ${JSON.stringify(p.consoleErrors)}`);
  const astLog = docker('logs', '--tail', '80', AST).out.split('\n');
  console.log(astLog.filter((l) => !/Remote UNIX/.test(l)).join('\n'));
  console.log(cli('pjsip show endpoints'));
  console.log(`phone log:\n${docker('exec', PHONE, 'tail', '-n', '20', '/phone/p/log').out}`);
  process.exitCode = 1;
} finally {
  await p.close();
  docker('rm', '-f', PHONE);
}
