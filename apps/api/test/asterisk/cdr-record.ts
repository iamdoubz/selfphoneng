// SPDX-License-Identifier: AGPL-3.0-or-later
// Records real AMI Cdr events for the call history fixtures (04 §5.4, 09 M7-T1). Our generated
// config is the PBX, a second Asterisk plays voip.ms (provider.ts), baresip phones answer:
//   101 Alice  auto-answer          102 Bob   never answers, voicemail on, rings 5 s
//   103 Carol  auto-answer          104 Dave  no phone, no voicemail
// Each scenario's Cdr events go to apps/api/test/fixtures/cdr/<name>.json.
// Queue 550 has Alice (answers); queue 551 has Bob (never answers) and sends callers who wait
// 8 s to his voicemail. Park: Alice parks a caller on 700 (→ 701), Carol picks it up.
// Usage: node --conditions=source apps/api/test/asterisk/cdr-record.ts
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettingsSchemas, type SettingKey } from '@selfphoneng/shared';
import { AmiClient } from '../../src/ami/client.ts';
import type { AmiMessage } from '../../src/ami/events.ts';
import { GENERATED_FILES, render } from '../../src/generator/index.ts';
import type { Snapshot, SnapExtension } from '../../src/generator/load.ts';
import { providerDialplan, providerPjsip } from './provider.ts';

const IMAGE = process.env.ASTERISK_IMAGE ?? 'selfphoneng-asterisk';
const OUT = fileURLToPath(new URL('../fixtures/cdr/', import.meta.url));
const NET = 'sp-cdr';
const PBX = 'sp-cdr-pbx';
const PROVIDER = 'sp-cdr-provider';
const PHONES = 'sp-cdr-phones';
const AMI_PORT = 15040;
const AMI_SECRET = 'cdr-record-secret';
const SUB = { user: '123456_pbx', pass: 'ProviderSecret42' };
const TRUNK = '7d3e9a52-1c4b-4f6e-9a0d-2b8c5e1f4a37';
const MOBILE = '3125559999';
export const CDR_IDS = {
  ext: (n: string) => `00000000-0000-4000-8000-000000000${n}`,
  did: (n: string) => `11111111-1111-4111-8111-11111111${n}`, // 1234 / 1235 / 1236
  ringGroup: '22222222-2222-4222-8222-222222222500',
  ivr: '33333333-3333-4333-8333-333333333600',
  queue: (n: string) => `44444444-4444-4444-8444-444444444${n}`,
};
const PASS = (n: string) => `CdrRecord${n}xxxxxxxxxxxxx`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (...args: string[]) => {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const log = (...a: unknown[]) => console.log('[cdr-record]', ...a);

function snapshot(): Snapshot {
  const settings = Object.fromEntries(
    (Object.keys(SettingsSchemas) as SettingKey[])
      .filter((k) => k !== 'sms.webhookToken')
      .map((k) => [k, SettingsSchemas[k].parse(undefined)]),
  ) as Snapshot['settings'];
  settings['routing.defaultCallerIdDidId'] = CDR_IDS.did('1234');
  const ext = (number: string, name: string, extra: Partial<SnapExtension> = {}) => ({
    id: CDR_IDS.ext(number),
    number,
    name,
    sipPassword: PASS(number),
    webrtcEnabled: false,
    maxContacts: 5,
    ringSeconds: 25,
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
    ...extra,
  });
  const did = (n: string, destination: Snapshot['dids'][number]['destination']) => ({
    id: CDR_IDS.did(n),
    number: `1312555${n}`,
    trunkId: TRUNK,
    label: null,
    destination,
    callerIdNamePrefix: null,
    recordInbound: false,
  });
  return {
    today: '2026-10-18',
    settings,
    extensions: [
      ext('101', 'Alice'),
      ext('102', 'Bob', { voicemailEnabled: true, ringSeconds: 5 }),
      ext('103', 'Carol'),
      ext('104', 'Dave'),
    ],
    dids: [
      did('1234', { type: 'user', id: CDR_IDS.ext('101') }),
      did('1235', { type: 'ring_group', id: CDR_IDS.ringGroup }),
      did('1236', { type: 'ivr', id: CDR_IDS.ivr }),
      did('1237', { type: 'queue', id: CDR_IDS.queue('550') }),
      did('1238', { type: 'queue', id: CDR_IDS.queue('551') }),
    ],
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
        id: CDR_IDS.ringGroup,
        number: '500',
        name: 'Sales',
        strategy: 'hunt',
        ringSeconds: 5,
        callerIdNamePrefix: null,
        musicInsteadOfRing: false,
        members: ['102', '103'],
        noAnswerDestination: { type: 'hangup' },
      },
    ],
    queues: (['550', '551'] as const).map((n) => ({
      id: CDR_IDS.queue(n),
      number: n,
      name: n === '550' ? 'Support' : 'Billing',
      strategy: 'rrmemory' as const,
      memberRingSeconds: 15,
      retrySeconds: 1,
      wrapupSeconds: 0,
      maxWaitSeconds: n === '550' ? 60 : 8,
      maxCallers: 0,
      mohClass: 'default',
      announcePosition: false,
      announceEverySeconds: 60,
      joinWhenNoAgents: false,
      record: false,
      callerIdNamePrefix: null,
      members: [
        n === '550'
          ? { number: '101', name: 'Alice', penalty: 0 }
          : { number: '102', name: 'Bob', penalty: 0 },
      ],
      timeoutDestination:
        n === '550'
          ? ({ type: 'hangup' } as const)
          : ({ type: 'voicemail', id: CDR_IDS.ext('102') } as const),
    })),
    conferences: [],
    pagingGroups: [],
    ivrs: [
      {
        id: CDR_IDS.ivr,
        number: '600',
        name: 'Main menu',
        greeting: 'beep',
        invalidSound: null,
        timeoutSeconds: 2,
        maxRetries: 1,
        allowDirectDial: false,
        options: [],
        timeoutDestination: { type: 'voicemail', id: CDR_IDS.ext('102') },
        invalidDestination: { type: 'hangup' },
      },
    ],
    timeConditions: [],
    holidays: [],
    announcements: [],
    recordingAnnouncement: null,
    routes: [
      {
        id: 'aaaaaaaa-0000-4000-8000-000000000001',
        name: 'Local and national',
        position: 0,
        enabled: true,
        patterns: [{ match: 'NXXNXXXXXX', strip: 0, prepend: '1' }],
        requiredClass: 'national',
        trunkIds: [TRUNK],
        callerId: null,
      },
    ],
  };
}

function phoneFiles(dir: string) {
  const phones: [string, 'auto' | 'manual'][] = [
    ['101', 'auto'],
    ['102', 'manual'],
    ['103', 'auto'],
  ];
  phones.forEach(([n, answer], i) => {
    const d = join(dir, `phone-${n}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, 'config'),
      [
        `sip_listen 0.0.0.0:${5070 + 2 * i}`,
        'module_path /usr/lib/baresip/modules',
        ...['g711', 'ausine', 'aufile', 'menu', 'account'].map((m) => `module ${m}.so`),
        `audio_source ausine,${440 + 110 * i}`,
        'ausrc_srate 48000',
        'auplay_srate 48000',
        'audio_player aufile,/dev/null',
        'audio_alert aufile,/dev/null',
        `rtp_ports ${30000 + 100 * i}-${30099 + 100 * i}`,
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(d, 'accounts'),
      `<sip:${n}@${PBX};transport=udp>;auth_pass=${PASS(n)};answermode=${answer};audio_codecs=PCMU\n`,
    );
  });
  return phones.map(([n]) => `(baresip -f /phones/phone-${n} > /phones/phone-${n}/log 2>&1 &)`);
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'sp-cdr-'));
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
          ? providerDialplan(MOBILE, SUB)
          : '',
    );
  }
  const runPhones = phoneFiles(dir);
  writeFileSync(
    join(dir, 'manager.conf.template'),
    '[general]\nenabled = yes\nport = 5038\nbindaddr = 0.0.0.0\n\n[selfphoneng]\nsecret = ${AMI_SECRET}\npermit = 0.0.0.0/0.0.0.0\nread = all\nwrite = all\n',
  );
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
  const waitFor = async (what: string, fn: () => Promise<boolean> | boolean, s = 60) => {
    for (let i = 0; i < s * 4; i++) {
      if (await fn()) return;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const cli = (box: string, c: string) => docker('exec', box, 'asterisk', '-rx', c).out;
  const quiet = async () => {
    cli(PBX, 'channel request hangup all');
    cli(PROVIDER, 'channel request hangup all');
    await waitFor(
      'calls to end',
      () => !/(PJSIP|Local)\//.test(cli(PBX, 'core show channels concise')),
    );
    await sleep(3000); // Cdr events follow the hangups
  };

  const events: AmiMessage[] = [];
  ami.on('event', (m: AmiMessage) => {
    if (m.Event === 'Cdr') events.push(m);
  });
  const recorded: Record<string, AmiMessage[]> = {};
  async function scenario(name: string, run: () => Promise<void>) {
    events.length = 0;
    await run();
    await quiet();
    recorded[name] = [...events];
    log(
      `${name}: ${events.length} Cdr events, linkedids ${[...new Set(events.map((e) => e.LinkedID))].join(' ')}`,
    );
  }
  const fromPhone = (phone: string, exten: string, name: string) =>
    ami.action({
      Action: 'Originate',
      Channel: `PJSIP/${phone}`,
      Context: 'sp-from-ext',
      Exten: exten,
      Priority: '1',
      CallerID: `"${name}" <${phone}>`,
      Async: 'true',
    });
  const fromMobile = (did10: string) =>
    cli(PROVIDER, `channel originate Local/${did10}@provider-out application Wait 30`);
  const pbxChannel = (prefix: string) =>
    cli(PBX, 'core show channels concise')
      .split('\n')
      .find((l) => l.startsWith(prefix))
      ?.split('!')[0];

  try {
    docker('rm', '-f', PBX, PROVIDER, PHONES);
    docker('network', 'create', NET);
    if (!asterisk(PROVIDER, provConf, []).ok) throw new Error('provider did not start');
    await waitFor(
      'provider',
      () => docker('exec', PROVIDER, 'asterisk', '-rx', 'core waitfullybooted').ok,
    );
    const pbx = asterisk(PBX, pbxConf, [
      '-p',
      `127.0.0.1:${AMI_PORT}:5038`,
      '-v',
      `${join(dir, 'manager.conf.template')}:/etc/asterisk/manager.conf.template:ro`,
    ]);
    if (!pbx.ok) throw new Error(`pbx: ${pbx.out}`);
    await waitFor('pbx', () => docker('exec', PBX, 'asterisk', '-rx', 'core waitfullybooted').ok);
    ami.start();
    await new Promise((r) => ami.once('connected', r));
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
      `apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends baresip-core >/dev/null 2>&1 && ${runPhones.join(' && ')} && sleep 3600`,
    );
    await waitFor(
      'phones and trunk',
      () => {
        const c = cli(PBX, 'pjsip show contacts');
        return (
          ['101', '102', '103'].every((n) => new RegExp(`${n}/sip:.*Avail`).test(c)) &&
          /Registered/.test(cli(PBX, 'pjsip show registrations'))
        );
      },
      240,
    );
    log('phones registered, trunk registered');

    await scenario('internal-answered', async () => {
      await fromPhone('103', '101', 'Carol');
      await waitFor('101 answers', () => !!pbxChannel('PJSIP/101-'));
      await sleep(5000);
    });
    await scenario('internal-voicemail', async () => {
      await fromPhone('103', '102', 'Carol');
      await waitFor(
        'voicemail',
        () => /VoiceMail/.test(cli(PBX, 'core show channels concise')),
        20,
      );
      await sleep(6000);
    });
    await scenario('internal-unavailable', async () => {
      await fromPhone('103', '104', 'Carol');
      await sleep(4000);
    });
    await scenario('inbound-user', async () => {
      fromMobile('3125551234');
      await waitFor('101 answers', () => !!pbxChannel('PJSIP/101-'));
      await sleep(5000);
    });
    await scenario('inbound-ringgroup', async () => {
      fromMobile('3125551235');
      await waitFor('103 answers', () => !!pbxChannel('PJSIP/103-'), 20);
      await sleep(4000);
    });
    await scenario('inbound-ivr-voicemail', async () => {
      fromMobile('3125551236');
      await waitFor(
        'voicemail',
        () => /VoiceMail/.test(cli(PBX, 'core show channels concise')),
        30,
      );
      await sleep(6000);
    });
    await scenario('outbound-answered', async () => {
      await fromPhone('101', '3125550000', 'Alice');
      await waitFor(
        'provider answers',
        () => /Echo/.test(cli(PROVIDER, 'core show channels concise')),
        20,
      );
      await sleep(5000);
    });
    await scenario('transfer', async () => {
      fromMobile('3125551234');
      await waitFor('101 answers', () => !!pbxChannel('PJSIP/101-'));
      await sleep(3000);
      await ami.action({
        Action: 'BlindTransfer',
        Channel: pbxChannel('PJSIP/101-')!,
        Context: 'sp-from-ext',
        Exten: '103',
      });
      await waitFor('103 answers', () => !!pbxChannel('PJSIP/103-'), 20);
      await sleep(4000);
    });

    await scenario('queue-answered', async () => {
      fromMobile('3125551237');
      await waitFor('101 answers', () => !!pbxChannel('PJSIP/101-'), 20);
      await sleep(4000);
    });
    await scenario('queue-abandoned', async () => {
      fromMobile('3125551238');
      await waitFor('102 rings', () => !!pbxChannel('PJSIP/102-'), 20);
      await sleep(3000); // the caller gives up before the 8 s limit
    });
    await scenario('queue-timeout-voicemail', async () => {
      fromMobile('3125551238');
      await waitFor(
        'voicemail',
        () => /VoiceMail/.test(cli(PBX, 'core show channels concise')),
        20,
      );
      await sleep(6000);
    });

    await scenario('park-pickup', async () => {
      fromMobile('3125551234');
      await waitFor('101 answers', () => !!pbxChannel('PJSIP/101-'));
      await sleep(2000);
      await ami.action({
        Action: 'BlindTransfer',
        Channel: pbxChannel('PJSIP/101-')!,
        Context: 'sp-from-ext',
        Exten: '700',
      });
      await waitFor('parked on 701', () => /701/.test(cli(PBX, 'parking show default')), 20);
      await sleep(2000);
      await fromPhone('103', '701', 'Carol');
      await waitFor('103 picks up', () => !!pbxChannel('PJSIP/103-'), 20);
      await sleep(4000);
    });

    mkdirSync(OUT, { recursive: true });
    for (const [name, evs] of Object.entries(recorded)) {
      if (!evs.length) throw new Error(`${name}: no Cdr events`);
      writeFileSync(join(OUT, `${name}.json`), JSON.stringify(evs, null, 2) + '\n');
    }
    log(`wrote ${Object.keys(recorded).length} fixtures to ${OUT}`);
  } finally {
    ami.stop();
    docker('rm', '-f', PHONES, PBX, PROVIDER);
    docker('network', 'rm', NET);
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
