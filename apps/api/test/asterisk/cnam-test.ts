// SPDX-License-Identifier: AGPL-3.0-or-later
// 11 §6 C4 against real Asterisk: a call from outside rings 101's phone with the caller's name
// from 101's contacts. A second Asterisk plays the provider, a baresip phone is 101, and a tiny
// stand-in for the api's /api/internal/caller-name runs in the PBX's network namespace (so it is
// 127.0.0.1 to Asterisk, as in production). What the phone sees is read from the INVITE the PBX
// sends it (pjsip logger).
// Checks: a contact's name; no contact keeps the provider's name; a ring group's "Sales:" prefix
// stays in front; the api not answering still rings with the provider's name; 101's contact name
// does not follow a forward to 102.
// Usage: node --conditions=source apps/api/test/asterisk/cnam-test.ts
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsSchemas, type SettingKey } from '@selfphoneng/shared';
import { AmiClient } from '../../src/ami/client.ts';
import { GENERATED_FILES, render } from '../../src/generator/index.ts';
import type { Snapshot } from '../../src/generator/load.ts';
import { providerPjsip } from './provider.ts';

const IMAGE = process.env.ASTERISK_IMAGE ?? 'selfphoneng-asterisk';
const NET = 'sp-cnam';
const PBX = 'sp-cnam-pbx';
const PROVIDER = 'sp-cnam-provider';
const PHONES = 'sp-cnam-phones';
const API = 'sp-cnam-api';
const AMI_PORT = 15041;
const AMI_SECRET = 'cnam-test-secret';
const TRUNK = '7d3e9a52-1c4b-4f6e-9a0d-2b8c5e1f4a37';
const SUB = { user: '123456_pbx', pass: 'ProviderSecret42' };
const TOKEN = 'ab'.repeat(32);
const EXT = {
  '101': '00000000-0000-4000-8000-000000000101',
  '102': '00000000-0000-4000-8000-000000000102',
};
const PASS = { '101': 'CnamTest101xxxxxxxxxxxxx', '102': 'CnamTest102xxxxxxxxxxxxx' };
const DID_USER = '13125551234'; // rings 101
const DID_GROUP = '13125551235'; // "Sales:" ring group 600 → 101
const KNOWN = '3125559999'; // Jane Doe in 101's contacts (10 digits, as voip.ms sends)
const UNKNOWN = '3125550001';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (...args: string[]) => {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const log = (...a: unknown[]) => console.log('[cnam-test]', ...a);

function snapshot(): Snapshot {
  const settings = Object.fromEntries(
    (Object.keys(SettingsSchemas) as SettingKey[])
      .filter((k) => k !== 'sms.webhookToken')
      .map((k) => [k, SettingsSchemas[k].parse(undefined)]),
  ) as Snapshot['settings'];
  const ext = (number: '101' | '102', name: string) => ({
    id: EXT[number],
    number,
    name,
    sipPassword: PASS[number],
    webrtcEnabled: false,
    maxContacts: 5,
    ringSeconds: 6, // the forward check waits for 101's no-answer
    voicemailEnabled: false,
    voicemailPin: '4826',
    outboundClass: 'national' as const,
    outboundCallerId: null,
    emergencyCallerId: null,
    recordMode: 'never' as const,
    pickupGroup: null,
    language: 'en',
    mohClass: 'default',
    isAdmin: false,
  });
  return {
    today: '2026-10-23',
    settings,
    callerNames: { url: 'http://127.0.0.1:8080/api/internal/caller-name', token: TOKEN },
    dids: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        number: DID_USER,
        trunkId: TRUNK,
        label: null,
        destination: { type: 'user', id: EXT['101'] },
        callerIdNamePrefix: null,
        recordInbound: false,
      },
      {
        id: '11111111-1111-4111-8111-111111111112',
        number: DID_GROUP,
        trunkId: TRUNK,
        label: null,
        destination: { type: 'ring_group', id: '22222222-2222-4222-8222-222222222222' },
        callerIdNamePrefix: null,
        recordInbound: false,
      },
    ],
    extensions: [ext('101', 'Alice'), ext('102', 'Bob')],
    trunks: [
      {
        id: TRUNK,
        name: 'voip.ms',
        enabled: true,
        serverHost: PROVIDER,
        serverPort: 5060,
        transport: 'udp',
        authMode: 'registration',
        username: SUB.user,
        password: SUB.pass,
        fromUser: null,
        fromDomain: null,
        codecs: ['ulaw'],
        srtp: false,
        maxChannels: null,
      },
    ],
    ringGroups: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        number: '600',
        name: 'Sales',
        strategy: 'ringall',
        ringSeconds: 20,
        callerIdNamePrefix: 'Sales:',
        musicInsteadOfRing: false,
        members: ['101'],
        noAnswerDestination: { type: 'hangup' },
      },
    ],
    queues: [],
    conferences: [],
    pagingGroups: [],
    mohClasses: [],
    ivrs: [],
    timeConditions: [],
    holidays: [],
    announcements: [],
    recordingAnnouncement: null,
    routes: [],
  };
}

/** The provider: "Mobile" <caller> calls one of our DIDs; ${CALLER} picks who calls. */
const providerDialplan = `[provider-out]
exten => _X.,1,Set(CALLERID(all)="Mobile" <\${CALLER}>)
 same => n,Dial(PJSIP/\${EXTEN}@${SUB.user},30)

[provider-wait]
exten => s,1,Answer()
 same => n,Wait(30)

[provider-in]
exten => _X.,1,Answer()
 same => n,Wait(30)
`;

/** baresip phones as 101 and 102: they ring, nobody answers (the INVITE is what we read). */
function phoneFiles(dir: string) {
  for (const n of ['101', '102'] as const) {
    const d = join(dir, `phone-${n}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, 'config'),
      [
        'poll_method epoll',
        `sip_listen 0.0.0.0:${n === '101' ? 5070 : 5072}`,
        'module_path /usr/lib/baresip/modules',
        'module g711.so',
        'module ausine.so',
        'module aufile.so',
        'module menu.so',
        'module account.so',
        'audio_source ausine,440',
        'audio_player aufile,/dev/null',
        'audio_alert aufile,/dev/null',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(d, 'accounts'),
      `<sip:${n}@${PBX};transport=udp>;auth_pass=${PASS[n]};answermode=manual;audio_codecs=PCMU;regint=60\n`,
    );
  }
}

/** The api's caller-name route, faked: Jane Doe for KNOWN in 101's book, with the right key. */
const FAKE_API = `
const http = require('http');
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const ok = u.pathname === '/api/internal/caller-name' && u.searchParams.get('token') === '${TOKEN}';
  const name = ok && u.searchParams.get('ext') === '101' && u.searchParams.get('number') === '1${KNOWN}' ? 'Jane Doe' : '';
  console.log('lookup ' + u.searchParams.get('ext') + ' ' + u.searchParams.get('number') + ' ' + (ok ? 'key-ok' : 'key-bad') + ' -> ' + JSON.stringify(name));
  if (process.env.SLOW) return setTimeout(() => res.end(name), 5000);
  res.end(name);
}).listen(8080, '127.0.0.1');
`;

async function waitFor(what: string, fn: () => Promise<boolean>, seconds = 60) {
  for (let i = 0; i < seconds; i++) {
    if (await fn()) return;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'sp-cnam-'));
  const pbxConf = join(dir, 'pbx');
  const provConf = join(dir, 'provider');
  mkdirSync(pbxConf);
  mkdirSync(provConf);
  const files = render(snapshot());
  for (const f of GENERATED_FILES) {
    writeFileSync(join(pbxConf, f), files[f]);
    writeFileSync(
      join(provConf, f),
      f === 'pjsip_selfphoneng.conf'
        ? providerPjsip(SUB)
        : f === 'extensions_selfphoneng.conf'
          ? providerDialplan
          : '',
    );
  }
  phoneFiles(dir);
  writeFileSync(
    join(dir, 'manager.conf.template'),
    '[general]\nenabled = yes\nport = 5038\nbindaddr = 0.0.0.0\n\n[selfphoneng]\nsecret = ${AMI_SECRET}\npermit = 0.0.0.0/0.0.0.0\nread = all\nwrite = all\n',
  );
  const problems: string[] = [];
  const ami = new AmiClient({
    host: '127.0.0.1',
    port: AMI_PORT,
    username: 'selfphoneng',
    secret: AMI_SECRET,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    backoffMs: [500],
  });
  const asterisk = (name: string, conf: string, extra: string[]) =>
    docker(
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '--network',
      NET,
      ...extra,
      '-e',
      `AMI_SECRET=${AMI_SECRET}`,
      '-v',
      `${conf}:/etc/asterisk/selfphoneng`,
      IMAGE,
    );
  const booted = (name: string) =>
    waitFor(
      `${name} to boot`,
      async () => docker('exec', name, 'asterisk', '-rx', 'core waitfullybooted').ok,
    );
  const startApi = (slow: boolean) => {
    docker('rm', '-f', API);
    const r = docker(
      'run',
      '-d',
      '--rm',
      '--name',
      API,
      '--network',
      `container:${PBX}`,
      ...(slow ? ['-e', 'SLOW=1'] : []),
      'node:22-alpine',
      'node',
      '-e',
      FAKE_API,
    );
    if (!r.ok) throw new Error(`fake api: ${r.out}`);
  };

  /** The provider calls `did` as `caller`; returns the From display name of the INVITE to `ext`. */
  async function ring(did: string, caller: string, ext: '101' | '102'): Promise<string | null> {
    // channel originate can't set a variable: the provider's dialplan reads a global.
    docker('exec', PROVIDER, 'asterisk', '-rx', `dialplan set global CALLER ${caller}`);
    const since = new Date().toISOString();
    await ami.command('pjsip set logger on');
    const o = docker(
      'exec',
      PROVIDER,
      'asterisk',
      '-rx',
      `channel originate Local/${did.slice(1)}@provider-out extension s@provider-wait`,
    );
    if (!o.ok) throw new Error(`originate: ${o.out}`);
    let from: string | null = null;
    await waitFor(
      `the INVITE to ${ext}`,
      async () => {
        const logs = docker('logs', '--since', since, PBX).out;
        const invites = logs
          .split(/<--- Transmitting SIP request/)
          .slice(1)
          .filter((b) => new RegExp(`^INVITE sip:${ext}[-@]`, 'm').test(b));
        const m = invites.map((b) => /^From: (?:"([^"]*)" )?</m.exec(b)).find(Boolean);
        if (m) from = m[1] ?? '';
        return m !== undefined;
      },
      20,
    );
    await ami.command('pjsip set logger off');
    await ami.command('channel request hangup all');
    docker('exec', PROVIDER, 'asterisk', '-rx', 'channel request hangup all');
    await sleep(2000);
    return from;
  }

  try {
    docker('rm', '-f', PBX, PROVIDER, PHONES, API);
    docker('network', 'create', NET);
    if (!asterisk(PROVIDER, provConf, []).ok) throw new Error('provider did not start');
    await booted(PROVIDER);
    const pbx = asterisk(PBX, pbxConf, [
      '-p',
      `127.0.0.1:${AMI_PORT}:5038`,
      '-v',
      `${join(dir, 'manager.conf.template')}:/etc/asterisk/manager.conf.template:ro`,
    ]);
    if (!pbx.ok) throw new Error(`pbx: ${pbx.out}`);
    await booted(PBX);
    startApi(false);
    ami.start();
    await new Promise((r) => ami.once('connected', r));
    await waitFor('the trunk to register', async () =>
      (await ami.actionList({ Action: 'PJSIPShowRegistrationsOutbound' })).some(
        (m) => m.Status === 'Registered',
      ),
    );

    log('starting baresip phones 101 and 102 (installs baresip on first run)…');
    const phones = docker(
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
        '(baresip -f /phones/phone-101 > /phones/phone-101/log 2>&1 &) && (baresip -f /phones/phone-102 > /phones/phone-102/log 2>&1 &) && sleep 900',
    );
    if (!phones.ok) throw new Error(`phones: ${phones.out}`);
    await waitFor(
      '101 and 102 to register',
      async () => {
        const c = await ami.command('pjsip show contacts');
        return /101\/sip:.*Avail/.test(c) && /102\/sip:.*Avail/.test(c);
      },
      240,
    );

    const expect = (what: string, got: string | null, want: string) => {
      log(`${what}: the phone shows ${JSON.stringify(got)}`);
      if (got !== want)
        problems.push(
          `${what}: phone showed ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
        );
    };
    expect('a contact calls 101', await ring(DID_USER, KNOWN, '101'), 'Jane Doe');
    expect('a stranger calls 101', await ring(DID_USER, UNKNOWN, '101'), 'Mobile');
    expect(
      'a contact calls the Sales group',
      await ring(DID_GROUP, KNOWN, '101'),
      'Sales: Jane Doe',
    );

    // 101 doesn't answer and forwards to 102 (AstDB SP/CFNA/101, as My settings writes it): 101's
    // phone showed Jane Doe, and 102 must not see 101's private contact name.
    await ami.command('database put SP CFNA/101 102');
    expect('101 unanswered, forwarded to 102', await ring(DID_USER, KNOWN, '102'), 'Mobile');
    await ami.command('database del SP CFNA/101');

    const lookups = docker('logs', API).out;
    if (!/lookup 101 13125559999 key-ok -> "Jane Doe"/.test(lookups))
      problems.push(`no keyed lookup for 101:\n${lookups}`);
    if (/key-bad/.test(lookups)) problems.push(`a lookup without the key:\n${lookups}`);

    // The api too slow (5 s, the dialplan waits 2): the phone still rings, with the provider's name.
    startApi(true);
    await sleep(1000);
    const t0 = Date.now();
    expect('the api does not answer in time', await ring(DID_USER, KNOWN, '101'), 'Mobile');
    log(`rang after ${Math.round((Date.now() - t0) / 100) / 10} s with the api hanging`);
  } finally {
    ami.stop();
    if (process.env.KEEP) log(`KEEP: containers left running, config in ${dir}`);
    else {
      docker('rm', '-f', PBX, PROVIDER, PHONES, API);
      docker('network', 'rm', NET);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (problems.length) {
    console.error(`[cnam-test] FAILED:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  log('PASS');
}

main().catch((e: unknown) => {
  console.error('[cnam-test]', e);
  process.exit(1);
});
