// SPDX-License-Identifier: AGPL-3.0-or-later
// M3 trunk checks against a fake provider: a second Asterisk plays voip.ms (a sub-account that
// registers), our generated config is the PBX. Everything runs on a private Docker bridge network.
// M3-T1: the good trunk registers, the one with a wrong password is rejected, and the AMI
// session can be recorded for the live-state tests.
// M3-T2: the provider calls our DID the way voip.ms does (10-digit Request-URI); a baresip phone
// registered as 101 answers, caller ID arrives normalized, and audio flows both ways.
// Usage: node --conditions=source apps/api/test/asterisk/trunk-test.ts [--record <file>]
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsSchemas, type SettingKey } from '@selfphoneng/shared';
import { AmiClient } from '../../src/ami/client.ts';
import { GENERATED_FILES, render } from '../../src/generator/index.ts';
import type { Snapshot } from '../../src/generator/load.ts';

import { providerDialplan, providerPjsip } from './provider.ts';

const IMAGE = process.env.ASTERISK_IMAGE ?? 'selfphoneng-asterisk';
const RECORD = process.argv.includes('--record')
  ? process.argv[process.argv.indexOf('--record') + 1]
  : undefined;
const NET = 'sp-trunk';
const PBX = 'sp-trunk-pbx';
const PROVIDER = 'sp-trunk-provider';
const AMI_PORT = 15039;
const AMI_SECRET = 'trunk-test-secret';
const GOOD = '7d3e9a52-1c4b-4f6e-9a0d-2b8c5e1f4a37';
const BAD = '0b9f6c21-8e4d-4a7b-b3c5-d1e2f3a4b5c6';
const SUB = { user: '123456_pbx', pass: 'ProviderSecret42' };
const PHONES = 'sp-trunk-phones';
const EXT_ID = '00000000-0000-4000-8000-000000000101';
const PHONE_PASS = 'TrunkTest101xxxxxxxxxxxx';
const DID = '13125551234';
const DID_ID = '11111111-1111-4111-8111-111111111111';
const MOBILE = '3125559999'; // the outside caller, 10 digits as voip.ms sends them

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (...args: string[]) => {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const log = (...a: unknown[]) => console.log(`[trunk-test]`, ...a);

function snapshot(): Snapshot {
  const settings = Object.fromEntries(
    (Object.keys(SettingsSchemas) as SettingKey[])
      .filter((k) => k !== 'sms.webhookToken')
      .map((k) => [k, SettingsSchemas[k].parse(undefined)]),
  ) as Snapshot['settings'];
  settings['routing.defaultCallerIdDidId'] = DID_ID;
  const trunk = (id: string, name: string, password: string) => ({
    id,
    name,
    enabled: true,
    serverHost: PROVIDER,
    serverPort: 5060,
    transport: 'udp' as const,
    authMode: 'registration' as const,
    username: SUB.user,
    password,
    fromUser: null,
    fromDomain: null,
    codecs: ['ulaw'],
    srtp: false,
    maxChannels: null,
  });
  return {
    today: '2026-10-17',
    settings,
    dids: [
      {
        id: DID_ID,
        number: DID,
        trunkId: GOOD,
        label: 'Main line',
        destination: { type: 'user', id: EXT_ID },
        callerIdNamePrefix: null,
      },
    ],
    extensions: [
      {
        id: EXT_ID,
        number: '101',
        name: 'Alice',
        sipPassword: PHONE_PASS,
        webrtcEnabled: false,
        maxContacts: 5,
        ringSeconds: 25,
        voicemailEnabled: false,
        voicemailPin: '4826',
        outboundClass: 'national',
        outboundCallerId: null,
        emergencyCallerId: null,
        recordMode: 'never',
        pickupGroup: null,
        language: 'en',
        mohClass: 'default',
        isAdmin: false,
      },
    ],
    trunks: [trunk(GOOD, 'voip.ms', SUB.pass), trunk(BAD, 'wrong password', 'NotThePassword1')],
    ringGroups: [],
    ivrs: [],
    timeConditions: [],
    holidays: [],
    announcements: [],
    routes: [
      {
        id: 'aaaaaaaa-0000-4000-8000-000000000001',
        name: 'Local and national',
        position: 0,
        enabled: true,
        patterns: [
          { match: 'NXXNXXXXXX', strip: 0, prepend: '1' },
          { match: '1NXXNXXXXXX', strip: 0, prepend: '' },
        ],
        requiredClass: 'national',
        trunkIds: [GOOD],
        callerId: null,
      },
    ],
  };
}

/** A baresip softphone registered as 101: auto-answers, sends a tone. */
function phoneFiles(dir: string) {
  const d = join(dir, 'phone-101');
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, 'config'),
    [
      'poll_method epoll',
      'sip_listen 0.0.0.0:5070',
      'module_path /usr/lib/baresip/modules',
      'module g711.so',
      'module ausine.so',
      'module aufile.so',
      'module menu.so',
      'module account.so',
      'audio_source ausine,440',
      'ausrc_srate 48000', // ausine only runs at 48 kHz (see call-test.ts)
      'auplay_srate 48000',
      'audio_player aufile,/phones/phone-101/heard.wav',
      'audio_alert aufile,/dev/null',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(d, 'accounts'),
    `<sip:101@${PBX};transport=udp>;auth_pass=${PHONE_PASS};answermode=auto;audio_codecs=PCMU;regint=60\n`,
  );
}

async function waitFor(what: string, fn: () => Promise<boolean>, seconds = 60) {
  for (let i = 0; i < seconds; i++) {
    if (await fn()) return;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'sp-trunk-'));
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
  phoneFiles(dir);
  writeFileSync(
    join(dir, 'manager.conf.template'),
    '[general]\nenabled = yes\nport = 5038\nbindaddr = 0.0.0.0\n\n[selfphoneng]\nsecret = ${AMI_SECRET}\npermit = 0.0.0.0/0.0.0.0\nread = all\nwrite = all\n',
  );

  const problems: string[] = [];
  let recorder: Socket | undefined;
  let raw = '';
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
  /** Holds the call 10 s, then both legs (101 and the trunk) must have RTP both ways. */
  async function checkAudio(what: string) {
    await sleep(10_000);
    const stats = await ami.command('pjsip show channelstats');
    // The ChannelId column is cut at 18 characters: "trunk-7d3e9a52-1c4".
    const rows = stats.split('\n').filter((l) => /^\s*\S+ (101-[0-9a-f]{8}|trunk-\S+) /.test(l));
    if (rows.length !== 2) problems.push(`${what}: expected the 101 and trunk legs in:\n${stats}`);
    for (const r of rows) {
      const cols = r.trim().split(/\s+/);
      const ulaw = cols.indexOf('ulaw');
      const rx = Number(cols[ulaw + 1]);
      const tx = Number(cols[ulaw + 5]);
      log(`${what} ${cols[1]}: rx ${rx}, tx ${tx}`);
      if (!(rx > 250) || !(tx > 250))
        problems.push(`${what}: one-way or no audio on ${cols[1]}: rx ${rx}, tx ${tx}`);
    }
    await ami.command('channel request hangup all');
    for (let i = 0; i < 10 && /PJSIP\//.test(await ami.command('core show channels concise')); i++)
      await sleep(500);
  }
  const booted = async (name: string) =>
    waitFor(
      `${name} to boot`,
      async () => docker('exec', name, 'asterisk', '-rx', 'core waitfullybooted').ok,
    );

  try {
    docker('rm', '-f', PBX, PROVIDER, PHONES);
    docker('network', 'create', NET);
    const prov = asterisk(PROVIDER, provConf, []);
    if (!prov.ok) throw new Error(`provider: ${prov.out}`);
    await booted(PROVIDER);
    // The PBX starts second: its identify sections resolve the provider's name at load.
    const pbx = asterisk(PBX, pbxConf, [
      '-p',
      `127.0.0.1:${AMI_PORT}:5038`,
      '-v',
      `${join(dir, 'manager.conf.template')}:/etc/asterisk/manager.conf.template:ro`,
    ]);
    if (!pbx.ok) throw new Error(`pbx: ${pbx.out}`);
    await booted(PBX);

    ami.start();
    await new Promise((r) => ami.once('connected', r));
    if (RECORD) {
      recorder = new Socket();
      recorder.setEncoding('latin1');
      recorder.on('data', (d: string) => (raw += d));
      await new Promise<void>((r) => recorder!.connect(AMI_PORT, '127.0.0.1', r));
      recorder.write(
        `Action: Login\r\nUsername: selfphoneng\r\nSecret: ${AMI_SECRET}\r\nEvents: on\r\nActionID: rec-1\r\n\r\n`,
      );
    }

    const regs = async () =>
      Object.fromEntries(
        (await ami.actionList({ Action: 'PJSIPShowRegistrationsOutbound' }))
          .filter((m) => m.Event === 'OutboundRegistrationDetail')
          .map((m) => [m.ObjectName, m.Status]),
      );
    await waitFor('both registrations to settle', async () => {
      const r = await regs();
      return r[`trunk-${GOOD}-reg`] === 'Registered' && r[`trunk-${BAD}-reg`] === 'Rejected';
    }).catch(async (e: Error) => {
      throw new Error(`${e.message}: ${JSON.stringify(await regs())}`);
    });
    log('good trunk Registered, wrong password Rejected');
    const onProvider = docker('exec', PROVIDER, 'asterisk', '-rx', 'pjsip show contacts').out;
    if (!onProvider.includes(`${SUB.user}/sip:${SUB.user}@`))
      problems.push(`provider has no contact for ${SUB.user}:\n${onProvider}`);
    // Qualify (OPTIONS) reaches the provider: the trunk AOR's contact turns Avail.
    await waitFor('trunk contact to be reachable', async () =>
      /trunk-7d3e9a52[^\n]*Avail/.test(await ami.command('pjsip show contacts')),
    );
    recorder?.write(
      'Action: PJSIPShowRegistrationsOutbound\r\nActionID: rec-2\r\n\r\n' +
        // Static trunk contacts aren't listed here ("No Contacts found")...
        'Action: PJSIPShowContacts\r\nActionID: rec-3\r\n\r\n' +
        // ...but the endpoint detail carries their qualify status.
        `Action: PJSIPShowEndpoint\r\nEndpoint: trunk-${GOOD}\r\nActionID: rec-4\r\n\r\n`,
    );
    await sleep(1000);
    recorder?.destroy(); // the fixture covers registration only
    recorder = undefined;

    // M3-T2: a call to the DID from outside rings 101.
    log('starting a baresip phone as 101 (installs baresip on first run)…');
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
        '(baresip -f /phones/phone-101 > /phones/phone-101/log 2>&1 &) && sleep 600',
    );
    if (!phones.ok) throw new Error(`phones: ${phones.out}`);
    await waitFor(
      '101 to register',
      async () => /101\/sip:.*Avail/.test(await ami.command('pjsip show contacts')),
      180,
    );
    const dials: Record<string, string | string[]>[] = [];
    ami.on('event:DialBegin', (m) => dials.push(m));
    const orig = docker(
      'exec',
      PROVIDER,
      'asterisk',
      '-rx',
      `channel originate Local/${DID.slice(1)}@provider-out extension s@provider-echo`,
    );
    if (!orig.ok) throw new Error(`originate on the provider: ${orig.out}`);
    let channels = '';
    await waitFor(
      'the inbound call to be answered by 101',
      async () => {
        channels = await ami.command('core show channels concise');
        const up = channels.split('\n').filter((l) => l.includes('!Up!'));
        return (
          up.some((l) => l.startsWith('PJSIP/101-')) && up.some((l) => l.startsWith('PJSIP/trunk-'))
        );
      },
      30,
    );
    log('inbound call answered by 101');
    const toPhone = dials.find((m) => String(m.DestChannel).startsWith('PJSIP/101-'));
    if (!toPhone) problems.push('no DialBegin to PJSIP/101');
    else if (toPhone.CallerIDNum !== `1${MOBILE}`)
      problems.push(`101 saw caller ID ${toPhone.CallerIDNum}, expected 1${MOBILE} (normalized)`);
    await checkAudio('inbound');

    // M3-T3: 101 dials a 10-digit number; it leaves as 11 digits with the DID as caller ID.
    const bothUp = async () => {
      const up = (await ami.command('core show channels concise'))
        .split('\n')
        .filter((l) => l.includes('!Up!'));
      return (
        up.some((l) => l.startsWith('PJSIP/101-')) && up.some((l) => l.startsWith('PJSIP/trunk-'))
      );
    };
    await ami.command(`channel originate PJSIP/101 extension 3125550000@sp-from-ext`);
    await waitFor('the outbound call to connect', bothUp, 30);
    const seen = docker('exec', PROVIDER, 'asterisk', '-rx', 'dialplan show globals').out;
    const lastIn = /LAST_IN=(.*)/.exec(seen)?.[1] ?? '';
    log(`provider received: ${lastIn}`);
    if (!lastIn.startsWith('to=13125550000 '))
      problems.push(`provider saw ${lastIn}, expected to=13125550000`);
    if (!new RegExp(`rpid=.*sip:${DID}@`).test(lastIn))
      problems.push(`caller ID ${DID} not in Remote-Party-ID: ${lastIn}`);
    await checkAudio('outbound');

    // A caller whose class is too low (a Local channel has no SP_CLASS) hears "no service".
    await ami.command('channel originate Local/13125550000@sp-from-ext application Wait 10');
    await waitFor(
      'ss-noservice',
      async () => /Playback!ss-noservice/.test(await ami.command('core show channels concise')),
      10,
    );
    log('class check: ss-noservice');
    await ami.command('channel request hangup all');

    // M3-T4: 911 from a caller with no class at all still goes out, with the E911 caller ID, and
    // the dialplan tells the api. (The fake provider answers it; nothing real is dialed.)
    const userEvents: Record<string, string | string[]>[] = [];
    ami.on('event:UserEvent', (m) => userEvents.push(m));
    await ami.command('channel originate Local/911@sp-from-ext application Wait 5');
    await waitFor(
      'the provider to receive 911',
      async () =>
        /LAST_IN=to=911 /.test(
          docker('exec', PROVIDER, 'asterisk', '-rx', 'dialplan show globals').out,
        ),
      15,
    );
    const e911 = /LAST_IN=(.*)/.exec(
      docker('exec', PROVIDER, 'asterisk', '-rx', 'dialplan show globals').out,
    )?.[1];
    log(`provider received: ${e911}`);
    if (!new RegExp(`rpid=.*sip:${DID}@`).test(e911 ?? ''))
      problems.push(`911 without the E911 caller ID ${DID}: ${e911}`);
    // AMI delivers the UserEvent asynchronously: it can arrive after the trunk call has started.
    await waitFor(
      'SpEmergency on AMI',
      async () => userEvents.some((m) => m.UserEvent === 'SpEmergency'),
      10,
    ).catch(() => {});
    const ev = userEvents.find((m) => m.UserEvent === 'SpEmergency');
    if (!ev || ev.CallerId !== DID || ev.Dialed !== '911')
      problems.push(`no SpEmergency UserEvent with CallerId ${DID}: ${JSON.stringify(userEvents)}`);
    await ami.command('channel request hangup all');
    // The alert ring-out the api originates: 101 answers and hears beeps and the extension.
    await ami.action({
      Action: 'Originate',
      Channel: 'PJSIP/101',
      Context: 'sp-emergency-alert',
      Exten: '102',
      Priority: '1',
      CallerID: '"EMERGENCY 911" <102>',
      Async: 'true',
    });
    await waitFor(
      'the alert to play on 101',
      async () =>
        /sp-emergency-alert!102!.*!Up!(Playback|SayDigits|Wait)/.test(
          await ami.command('core show channels concise'),
        ),
      15,
    );
    log('911: out with the E911 caller ID, SpEmergency raised, alert plays on 101');
    await ami.command('channel request hangup all');

    // eslint-disable-next-line no-control-regex -- strips Asterisk's ANSI colors
    const plainLog = docker('logs', PBX).out.replace(/\x1b\[[0-9;]*m/g, '');
    // An RTCP report sent while a test container's network is going away fails with EPERM;
    // that's teardown noise, not a config problem.
    const errors = plainLog
      .split('\n')
      .filter((l) => /ERROR\[/.test(l) && !/RTCP SR transmission error/.test(l));
    problems.push(...errors.map((l) => `pbx log: ${l.trim()}`));
  } catch (e) {
    problems.push((e as Error).message);
  } finally {
    if (RECORD && raw) {
      writeFileSync(RECORD, raw, 'latin1');
      log(`recorded ${raw.length} bytes of AMI to ${RECORD}`);
    }
    recorder?.destroy();
    ami.stop();
    docker('rm', '-f', PBX, PROVIDER, PHONES);
    docker('network', 'rm', NET);
    rmSync(dir, { recursive: true, force: true });
  }
  if (problems.length) {
    console.log('FAIL trunks');
    for (const p of problems) console.log(`     ${p}`);
    process.exit(1);
  }
  console.log(
    'ok   trunks (registration, rejection, qualify, inbound DID → 101, outbound with DID caller ID, class check, 911)',
  );
}

await main();
