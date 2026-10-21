// SPDX-License-Identifier: AGPL-3.0-or-later
// M2 milestone check, automated (09 M2-T6): two softphones (baresip) register as 101 and 102,
// 102 calls 101 through our generated dialplan, and RTP must flow both ways for CALL_SECONDS.
// Everything runs on a private Docker bridge network: no host networking, no image builds.
// Usage: node --conditions=source apps/api/test/asterisk/call-test.ts [--record <file>]
//   ASTERISK_IMAGE (default selfphoneng-asterisk), CALL_SECONDS (default 30)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsSchemas, type SettingKey } from '@selfphoneng/shared';
import { AmiClient } from '../../src/ami/client.ts';
import { GENERATED_FILES, render } from '../../src/generator/index.ts';
import type { Snapshot } from '../../src/generator/load.ts';

const IMAGE = process.env.ASTERISK_IMAGE ?? 'selfphoneng-asterisk';
const CALL_SECONDS = Number(process.env.CALL_SECONDS ?? 30);
const RECORD = process.argv.includes('--record')
  ? process.argv[process.argv.indexOf('--record') + 1]
  : undefined;
const NET = 'sp-test';
const AST = 'sp-test-ast';
const PHONES = 'sp-test-phones';
const PN_PHONE = 'sp-test-pn-phone';
const RTP_PORTS = { start: 31000, end: 31200 };
const AMI_PORT = 15038;
const AMI_SECRET = 'call-test-secret';
const PASS = { '101': 'CallTest101xxxxxxxxxxxxx', '102': 'CallTest102xxxxxxxxxxxxx' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (...args: string[]) => {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const log = (...a: unknown[]) => console.log(`[call-test]`, ...a);

function snapshot(): Snapshot {
  const settings = Object.fromEntries(
    (Object.keys(SettingsSchemas) as SettingKey[])
      .filter((k) => k !== 'sms.webhookToken')
      .map((k) => [k, SettingsSchemas[k].parse(undefined)]),
  ) as Snapshot['settings'];
  // Phone ACL on, the Docker networks allowed: the desk phones register, a "-web" login doesn't.
  settings['sip.restrictPhonesToLocalNets'] = true;
  settings['network.localNets'] = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];
  const ext = (number: '101' | '102', name: string) => ({
    id: `00000000-0000-4000-8000-000000000${number}`,
    number,
    name,
    sipPassword: PASS[number],
    webrtcEnabled: number === '102',
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
  });
  return {
    today: '2026-10-17',
    settings,
    dids: [],
    trunks: [],
    routes: [],
    ringGroups: [],
    queues: [],
    conferences: [],
    pagingGroups: [],
    mohClasses: [],
    ivrs: [],
    timeConditions: [],
    holidays: [],
    announcements: [],
    recordingAnnouncement: null,
    extensions: [ext('101', 'Alice'), ext('102', 'Bob')],
    // Not rtp.conf's 10000–20000: the generated range must win (RTP_PORT_START/END).
    rtpPorts: RTP_PORTS,
  };
}

/** baresip config for one phone: G.711 µ-law, a sine tone as the microphone, auto-answer. */
function phoneConfig(dir: string, ext: '101' | '102', port: number, toneHz: number) {
  const d = join(dir, `phone-${ext}`);
  spawnSync('mkdir', ['-p', d]);
  writeFileSync(
    join(d, 'config'),
    [
      'poll_method epoll',
      `sip_listen 0.0.0.0:${port}`,
      'module_path /usr/lib/baresip/modules',
      'module g711.so',
      'module ausine.so',
      'module aufile.so',
      'module menu.so',
      'module account.so',
      `audio_source ausine,${toneHz}`,
      'ausrc_srate 48000', // ausine only runs at 48 kHz; baresip resamples for G.711
      'auplay_srate 48000',
      `audio_player aufile,/phones/phone-${ext}/heard.wav`,
      'audio_alert aufile,/dev/null',
      'rtp_ports 30000-30100',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(d, 'accounts'),
    `<sip:${ext}@${AST};transport=udp>;auth_pass=${PASS[ext]};answermode=auto;audio_codecs=PCMU;regint=60\n` +
      // M11-T8: the desk phone's password also opens 102-web; over UDP from a phone's network
      // that must fail (browsers only come through the reverse proxy on 127.0.0.1).
      (ext === '102'
        ? `<sip:102-web@${AST};transport=udp>;auth_pass=${PASS[ext]};answermode=manual;regint=60\n`
        : ''),
  );
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'sp-call-'));
  const conf = join(dir, 'conf');
  spawnSync('mkdir', ['-p', conf]);
  const files = render(snapshot());
  for (const f of GENERATED_FILES) writeFileSync(join(conf, f), files[f]);
  // Test-only manager.conf: reachable through the published port (the real one is 127.0.0.1-only).
  writeFileSync(
    join(dir, 'manager.conf.template'),
    '[general]\nenabled = yes\nport = 5038\nbindaddr = 0.0.0.0\n\n[selfphoneng]\nsecret = ${AMI_SECRET}\npermit = 0.0.0.0/0.0.0.0\nread = all\nwrite = all\n',
  );
  phoneConfig(dir, '101', 5070, 440);
  phoneConfig(dir, '102', 5072, 880);

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
  try {
    docker('rm', '-f', AST, PHONES, PN_PHONE);
    docker('network', 'create', NET);
    const run = docker(
      'run',
      '-d',
      '--rm',
      '--name',
      AST,
      '--network',
      NET,
      '-p',
      `127.0.0.1:${AMI_PORT}:5038`,
      '-e',
      `AMI_SECRET=${AMI_SECRET}`,
      '-v',
      `${conf}:/etc/asterisk/selfphoneng`,
      '-v',
      `${join(dir, 'manager.conf.template')}:/etc/asterisk/manager.conf.template:ro`,
      IMAGE,
    );
    if (!run.ok) throw new Error(`asterisk: ${run.out}`);
    for (
      let i = 0;
      i < 60 && !docker('exec', AST, 'asterisk', '-rx', 'core waitfullybooted').ok;
      i++
    )
      await sleep(500);

    ami.start();
    await new Promise((r) => ami.once('connected', r));
    log('AMI connected from the host');
    const rtp = await ami.command('rtp show settings');
    if (
      !new RegExp(`Port start:\\s+${RTP_PORTS.start}\\b`).test(rtp) ||
      !new RegExp(`Port end:\\s+${RTP_PORTS.end}\\b`).test(rtp)
    )
      problems.push(`RTP ports aren't ${RTP_PORTS.start}–${RTP_PORTS.end}:\n${rtp}`);
    else log(`RTP ports ${RTP_PORTS.start}–${RTP_PORTS.end} (generated, over rtp.conf's)`);
    if (RECORD) {
      // A second, raw AMI session so the fixture holds exactly what Asterisk sent.
      recorder = new Socket();
      recorder.setEncoding('latin1');
      recorder.on('data', (d: string) => (raw += d));
      await new Promise<void>((r) => recorder!.connect(AMI_PORT, '127.0.0.1', r));
      recorder.write(
        `Action: Login\r\nUsername: selfphoneng\r\nSecret: ${AMI_SECRET}\r\nEvents: on\r\nActionID: rec-1\r\n\r\n`,
      );
    }
    const states: string[] = [];
    ami.on('event:ExtensionStatus', (m) => states.push(`${m.Exten}:${m.StatusText}`));

    log('starting baresip phones (installs baresip on first run)…');
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
        '(baresip -f /phones/phone-101 > /phones/phone-101/log 2>&1 &) && ' +
        '(baresip -f /phones/phone-102 > /phones/phone-102/log 2>&1 &) && sleep 600',
    );
    if (!phones.ok) throw new Error(`phones: ${phones.out}`);

    let contacts = '';
    for (let i = 0; i < 180; i++) {
      contacts = await ami.command('pjsip show contacts').catch(() => '');
      if (/101\/sip:.*Avail/.test(contacts) && /102\/sip:.*Avail/.test(contacts)) break;
      await sleep(1000);
    }
    if (!/101\/sip:.*Avail/.test(contacts) || !/102\/sip:.*Avail/.test(contacts))
      throw new Error(`phones did not register:\n${contacts}`);
    log('101 and 102 registered');
    await sleep(3000);
    if (/102-web\/sip:/.test(await ami.command('pjsip show contacts')))
      problems.push('102-web registered over UDP from the phones network with the ACL on');
    else log('102-web over UDP: refused (phone ACL covers browser endpoints)');
    // ...while a browser through the reverse proxy (WebSocket from 127.0.0.1) still registers.
    const wsReg = docker(
      'run',
      '--rm',
      '--network',
      `container:${AST}`,
      '-v',
      `${join(import.meta.dirname, 'ws-register.mjs')}:/ws-register.mjs:ro`,
      'node:24-trixie-slim',
      'node',
      '/ws-register.mjs',
      'ws://127.0.0.1:8088/ws',
      '102-web',
      PASS['102'],
    ).out.trim();
    if (!wsReg.startsWith('SIP/2.0 200')) problems.push(`102-web over WebSocket: ${wsReg}`);
    else log('102-web over WebSocket from 127.0.0.1: registered');
    // The network test probe's SIP checks (08 §2.6): Asterisk answers its OPTIONS, UDP and TCP.
    const probed = docker(
      'run',
      '--rm',
      '--network',
      NET,
      '-v',
      `${join(import.meta.dirname, '../../../probe/src')}:/probe:ro`,
      'node:24-trixie-slim',
      'node',
      '--input-type=module',
      '-e',
      `import { runTest } from '/probe/checks.ts';
       for (const kind of ['sip-udp', 'sip-tcp'])
         console.log(JSON.stringify(await runTest('${AST}', 'pbx.test', { id: kind, kind, port: 5060 })));`,
    ).out;
    for (const kind of ['sip-udp', 'sip-tcp'])
      if (!new RegExp(`"id":"${kind}","ok":true,"detail":"SIP/2.0 \\d{3}`).test(probed))
        problems.push(`probe ${kind}: ${probed.trim()}`);
    if (!problems.some((p) => p.startsWith('probe ')))
      log(`probe: Asterisk answers SIP OPTIONS over UDP and TCP`);
    // 101 also on an iOS Linphone: '&' in its push params used to break Dial for every device.
    const pn = docker(
      'run',
      '-d',
      '--rm',
      '--name',
      PN_PHONE,
      '--network',
      NET,
      '-v',
      `${join(import.meta.dirname, 'pn-phone.mjs')}:/pn-phone.mjs:ro`,
      'node:24-trixie-slim',
      'node',
      '/pn-phone.mjs',
      AST,
      '101',
      PASS['101'],
    );
    if (!pn.ok) throw new Error(`pn phone: ${pn.out}`);
    for (let i = 0; i < 20 && !/REGISTER SIP\/2.0 200/.test(docker('logs', PN_PHONE).out); i++)
      await sleep(500);
    if (!/REGISTER SIP\/2.0 200/.test(docker('logs', PN_PHONE).out))
      throw new Error(`pn phone did not register: ${docker('logs', PN_PHONE).out}`);
    log('101 also registered with iOS Linphone push params');
    // Real list responses with registered phones, for the live-state fixture.
    recorder?.write(
      'Action: PJSIPShowContacts\r\nActionID: rec-2\r\n\r\n' +
        'Action: ExtensionStateList\r\nActionID: rec-3\r\n\r\n',
    );

    // 102 rings first (auto-answer), then the dialplan dials 101 like a normal internal call.
    await ami.action({
      Action: 'Originate',
      Channel: 'PJSIP/102',
      Context: 'sp-from-ext',
      Exten: '101',
      Priority: '1',
      CallerID: '"Bob" <102>',
      Async: 'true',
    });
    let channels = '';
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      channels = await ami.command('core show channels concise');
      if (
        channels.split('\n').filter((l) => l.startsWith('PJSIP/')).length >= 2 &&
        /Up!Dial/.test(channels)
      )
        break;
    }
    if (!/Up!Dial/.test(channels)) throw new Error(`call did not connect:\n${channels}`);
    // Rung too, without its pn-* params; the rest of its Contact kept.
    const pnInvite = /^INVITE .*$/m.exec(docker('logs', PN_PHONE).out)?.[0] ?? 'no INVITE';
    if (!/;x-test=keep-me$/.test(pnInvite) || /pn-/.test(pnInvite))
      problems.push(`push-params phone: ${pnInvite}`);
    else log(`push-params phone rung: ${pnInvite}`);
    log(`call up, holding ${CALL_SECONDS} s`);
    await sleep(CALL_SECONDS * 1000);

    const stats = await ami.command('pjsip show channelstats');
    const rows = stats.split('\n').filter((l) => /\b10[12]-[0-9a-f]+\b/.test(l));
    if (rows.length < 2) problems.push(`expected 2 channels in channelstats:\n${stats}`);
    for (const r of rows) {
      // Columns: BridgeId ChannelId ........ UpTime.. Codec.   Count    Lost Pct  Jitter   Count    Lost Pct  Jitter RTT....
      const nums = r.trim().split(/\s+/);
      const ulaw = nums.indexOf('ulaw');
      const rx = Number(nums[ulaw + 1]);
      const tx = Number(nums[ulaw + 5]);
      log(`${nums[1]}: rx ${rx} packets, tx ${tx} packets`);
      // 50 packets/s for 20 ms frames: demand at least half of that both ways.
      if (!(rx > CALL_SECONDS * 25) || !(tx > CALL_SECONDS * 25))
        problems.push(`one-way or no audio on ${nums[1]}: rx ${rx}, tx ${tx}`);
    }
    for (const e of ['101', '102'])
      if (!states.includes(`${e}:InUse`))
        problems.push(`no ExtensionStatus InUse for ${e} (got ${states.join(', ')})`);

    await ami.command('channel request hangup all');
    for (let i = 0; i < 10 && /PJSIP\//.test(await ami.command('core show channels concise')); i++)
      await sleep(500);
    await sleep(1000);
    if (!states.slice(-4).some((s) => s.endsWith(':Idle')))
      problems.push(`extensions did not return to Idle: ${states.join(', ')}`);
    // eslint-disable-next-line no-control-regex -- strips Asterisk's ANSI colors
    const plainLog = docker('logs', AST).out.replace(/\x1b\[[0-9;]*m/g, '');
    const errors = plainLog.split('\n').filter((l) => /ERROR\[/.test(l));
    problems.push(...errors.map((l) => `log: ${l.trim()}`));
  } catch (e) {
    problems.push((e as Error).message);
  } finally {
    if (RECORD && raw) {
      writeFileSync(RECORD, raw, 'latin1');
      log(`recorded ${raw.length} bytes of AMI to ${RECORD}`);
    }
    if (problems.length)
      for (const e of ['101', '102'])
        log(`phone ${e} log (tail):
${docker('exec', PHONES, 'tail', '-n', '25', `/phones/phone-${e}/log`).out}`);
    recorder?.destroy();
    ami.stop();
    docker('rm', '-f', PHONES, PN_PHONE, AST);
    docker('network', 'rm', NET);
    rmSync(dir, { recursive: true, force: true });
  }
  if (problems.length) {
    console.log('FAIL register-and-call');
    for (const p of problems) console.log(`     ${p}`);
    process.exit(1);
  }
  console.log('ok   register-and-call (two-way audio)');
}

await main();
