// SPDX-License-Identifier: AGPL-3.0-or-later
// M2 live loop on any Docker host (no host networking): a test Asterisk on a bridge network with
// AMI published on 127.0.0.1:15038, the api writing its config into that container, two baresip
// phones, and the dashboard checked in a headless browser.
//
// 1. node scripts/e2e/m2-live.mjs up <confDir> [<voicemailDir>]
//      starts Asterisk; then start the api with AMI_PORT=15038 AMI_SECRET=m2-live-secret
//      ASTERISK_CONFIG_DIR=<confDir> [VOICEMAIL_DIR=<voicemailDir>] and run m1-t4.mjs to get
//      past the first login
// 2. node scripts/e2e/m2-live.mjs check <baseUrl> <adminEmail> <adminPassword> <shotsDir>
// 3. node scripts/e2e/m2-live.mjs down
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './cdp.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const PHONES = 'sp-live-phones';
const IMAGE = process.env.ASTERISK_IMAGE ?? 'selfphoneng-asterisk';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...a) => {
  const r = spawnSync('docker', a, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const cli = (cmd) => docker('exec', AST, 'asterisk', '-rx', cmd).out;
const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'up') {
  const [conf, vm] = args;
  mkdirSync(conf, { recursive: true });
  if (vm) mkdirSync(vm, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'sp-live-'));
  writeFileSync(
    join(dir, 'manager.conf.template'),
    '[general]\nenabled = yes\nport = 5038\nbindaddr = 0.0.0.0\n\n[selfphoneng]\nsecret = ${AMI_SECRET}\npermit = 0.0.0.0/0.0.0.0\nread = all\nwrite = all\n',
  );
  // The browser softphone (m5-*) runs on the host: SIP-over-WebSocket and a small RTP range are
  // published on 127.0.0.1, and the api maps the container's ICE candidate to 127.0.0.1.
  writeFileSync(
    join(dir, 'http.conf'),
    '[general]\nenabled = yes\nbindaddr = 0.0.0.0\nbindport = 8088\nenablestatic = no\n',
  );
  writeFileSync(
    join(dir, 'rtp.conf'),
    '[general]\nrtpstart = 10000\nrtpend = 10019\n#include selfphoneng/rtp_selfphoneng.conf\n',
  );
  docker('rm', '-f', AST, PHONES);
  docker('network', 'create', NET);
  const r = docker(
    'run',
    '-d',
    '--rm',
    '--name',
    AST,
    '--network',
    NET,
    '-p',
    '127.0.0.1:15038:5038',
    '-p',
    '127.0.0.1:18088:8088',
    '-p',
    '127.0.0.1:10000-10019:10000-10019/udp',
    '-e',
    'AMI_SECRET=m2-live-secret',
    '-v',
    `${conf}:/etc/asterisk/selfphoneng`,
    '-v',
    `${join(dir, 'manager.conf.template')}:/etc/asterisk/manager.conf.template:ro`,
    '-v',
    `${join(dir, 'http.conf')}:/etc/asterisk/http.conf:ro`,
    '-v',
    `${join(dir, 'rtp.conf')}:/etc/asterisk/rtp.conf:ro`,
    ...(vm ? ['-v', `${vm}:/var/spool/asterisk/voicemail`] : []),
    IMAGE,
  );
  assert.ok(r.ok, r.out);
  for (let i = 0; i < 60 && !docker('exec', AST, 'asterisk', '-rx', 'core waitfullybooted').ok; i++)
    await sleep(500);
  console.log('asterisk up; AMI on 127.0.0.1:15038, secret m2-live-secret');
} else if (cmd === 'down') {
  docker('rm', '-f', PHONES, AST, 'sp-live-provider', 'sp-live-phone101');
  docker('network', 'rm', NET);
} else if (cmd === 'check') {
  const [base, email, pw, shotsDir] = args;
  // API session for setup steps the UI already covers elsewhere.
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'selfphoneng' },
    body: JSON.stringify({ email, password: pw }),
  });
  assert.equal(login.status, 200, 'api login');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = async (method, path, body) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: {
        cookie,
        'x-requested-with': 'selfphoneng',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`);
    return data;
  };

  // 1. Create two users with extensions; each endpoint must exist in Asterisk within 2 s (M2-T5).
  const exts = {};
  for (const [name, number] of [
    ['Alice', '201'],
    ['Bob', '202'],
  ]) {
    const { user } = await api('POST', '/api/users', {
      email: `${name.toLowerCase()}@example.com`,
      displayName: name,
    });
    const t0 = Date.now();
    const ext = await api('POST', '/api/extensions', {
      number,
      name,
      userId: user.id,
      webrtcEnabled: false,
    });
    let shown = '';
    while (
      Date.now() - t0 < 4000 &&
      !/Endpoint:\s+\S+/.test((shown = cli(`pjsip show endpoint ${number}`)))
    )
      await sleep(100);
    const ms = Date.now() - t0;
    assert.match(shown, new RegExp(`Endpoint:\\s+${number}/`), `endpoint ${number} in Asterisk`);
    console.log(`endpoint ${number} live in Asterisk ${ms} ms after the API call`);
    assert.ok(ms <= 2000, `M2-T5: within 2 s (took ${ms} ms)`);
    exts[number] = (await api('GET', `/api/extensions/${ext.id}/sip-credentials`)).password;
  }

  // 2. Two softphones register.
  const dir = mkdtempSync(join(tmpdir(), 'sp-live-phones-'));
  let port = 5070;
  for (const [n, pass] of Object.entries(exts)) {
    const d = join(dir, `phone-${n}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, 'config'),
      [
        `sip_listen 0.0.0.0:${port}`,
        'module_path /usr/lib/baresip/modules',
        'module g711.so',
        'module ausine.so',
        'module aufile.so',
        'module menu.so',
        'module account.so',
        'audio_source ausine,440',
        'ausrc_srate 48000',
        'auplay_srate 48000',
        `audio_player aufile,/phones/phone-${n}/heard.wav`,
        'audio_alert aufile,/dev/null',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(d, 'accounts'),
      `<sip:${n}@${AST};transport=udp>;auth_pass=${pass};answermode=auto;audio_codecs=PCMU\n`,
    );
    port += 2;
  }
  docker('rm', '-f', PHONES);
  assert.ok(
    docker(
      'run',
      '-d',
      '--rm',
      '--name',
      PHONES,
      '--network',
      NET,
      '-v',
      `${dir}:/phones`,
      'debian:trixie-slim',
      'sh',
      '-c',
      'apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends baresip-core >/dev/null 2>&1 && ' +
        Object.keys(exts)
          .map((n) => `(baresip -f /phones/phone-${n} > /phones/phone-${n}/log 2>&1 &)`)
          .join(' && ') +
        ' && sleep 900',
    ).ok,
  );

  const p = await launch({ shotsDir });
  try {
    await p.goto(`${base}/login`);
    await p.waitFor(`!!document.querySelector('input[type=email]')`);
    await p.fill('Email', email);
    await p.fill('Password', pw);
    await p.click('Sign in');
    await p.waitFor(`location.pathname === '/admin'`);
    await p.waitFor(
      `document.body.innerText.includes('Connected')`,
      'telephony engine connected',
      15000,
    );
    await p.waitFor(
      `/Extensions online\\s*2 \\/ 2/.test(document.body.innerText)`,
      'both phones online',
      180000,
    );
    await p.shot('m2-live-01-online');
    console.log('dashboard: 2 / 2 online');

    // 3. A call: dots turn red, "On a call" shows 2.
    cli('channel originate PJSIP/202 extension 201@sp-from-ext');
    await p.waitFor(`/On a call\\s*2/.test(document.body.innerText)`, 'both on a call', 20000);
    const red = await p.evaluate(
      `[...document.querySelectorAll('li span[aria-hidden]')].filter(s => s.className.includes('bg-red-500')).length`,
    );
    assert.equal(red, 2, 'two red dots');
    await p.shot('m2-live-02-on-call');
    console.log('dashboard: both extensions on a call, dots red');
    await p.click('Users & Extensions');
    await p.waitFor(
      `document.querySelectorAll('td .bg-red-500').length === 2`,
      'red dots in the users table',
    );
    await p.shot('m2-live-03-users-on-call');

    cli('channel request hangup all');
    await p.click('Dashboard');
    await p.waitFor(`/On a call\\s*0/.test(document.body.innerText)`, 'call ended');
    assert.deepEqual(p.consoleErrors, [], 'no console errors');
    console.log('M2 live loop: PASS');
  } catch (e) {
    await p.shot('m2-live-FAILED').catch(() => {});
    console.error('FAIL:', e.message, '\nconsole:', p.consoleErrors);
    process.exitCode = 1;
  } finally {
    await p.close();
  }
} else {
  console.log(
    'usage: m2-live.mjs up <confDir> | check <baseUrl> <email> <password> <shotsDir> | down',
  );
  process.exitCode = 2;
}
