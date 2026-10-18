// SPDX-License-Identifier: AGPL-3.0-or-later
// M4-T1 check, automated (09 M4-T1): 102 calls 101, nobody answers, 102 leaves a message, the
// message-waiting light on 101's phone turns on (baresip mwi module), and *97 plays it.
// Same setup as call-test.ts: private Docker bridge, baresip phones, no image builds.
// Usage: node --conditions=source apps/api/test/asterisk/voicemail-test.ts
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsSchemas, type SettingKey } from '@selfphoneng/shared';
import { AmiClient } from '../../src/ami/client.ts';
import { GENERATED_FILES, render } from '../../src/generator/index.ts';
import type { Snapshot } from '../../src/generator/load.ts';

const IMAGE = process.env.ASTERISK_IMAGE ?? 'selfphoneng-asterisk';
const NET = 'sp-vm';
const AST = 'sp-vm-ast';
const PHONES = 'sp-vm-phones';
const AMI_PORT = 15039;
const AMI_SECRET = 'vm-test-secret';
const PASS = { '101': 'VmTest101xxxxxxxxxxxxxxx', '102': 'VmTest102xxxxxxxxxxxxxxx' };
const PIN = '4826';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (...args: string[]) => {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const log = (...a: unknown[]) => console.log(`[voicemail-test]`, ...a);

function snapshot(): Snapshot {
  const settings = Object.fromEntries(
    (Object.keys(SettingsSchemas) as SettingKey[])
      .filter((k) => k !== 'sms.webhookToken')
      .map((k) => [k, SettingsSchemas[k].parse(undefined)]),
  ) as Snapshot['settings'];
  const ext = (number: '101' | '102', name: string) => ({
    id: `00000000-0000-4000-8000-000000000${number}`,
    number,
    name,
    sipPassword: PASS[number],
    webrtcEnabled: false,
    maxContacts: 5,
    ringSeconds: 5,
    voicemailEnabled: true,
    voicemailPin: PIN,
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
    ivrs: [],
    timeConditions: [],
    holidays: [],
    announcements: [],
    recordingAnnouncement: null,
    extensions: [ext('101', 'Alice'), ext('102', 'Bob')],
  };
}

/** 101 never answers and subscribes to MWI; 102 auto-answers and "talks" (a sine tone). */
function phoneConfig(dir: string, ext: '101' | '102', port: number) {
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
      'module mwi.so',
      'audio_source ausine,880',
      'ausrc_srate 48000',
      'auplay_srate 48000',
      'audio_player aufile,/dev/null',
      'audio_alert aufile,/dev/null',
      'rtp_ports 30000-30100',
      '',
    ].join('\n'),
  );
  const answer = ext === '102' ? 'auto' : 'manual';
  writeFileSync(
    join(d, 'accounts'),
    `<sip:${ext}@${AST};transport=udp>;auth_pass=${PASS[ext]};answermode=${answer};audio_codecs=PCMU;regint=60;mwi=yes\n`,
  );
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'sp-vm-'));
  const conf = join(dir, 'conf');
  spawnSync('mkdir', ['-p', conf]);
  const files = render(snapshot());
  for (const f of GENERATED_FILES) writeFileSync(join(conf, f), files[f]);
  writeFileSync(
    join(dir, 'manager.conf.template'),
    '[general]\nenabled = yes\nport = 5038\nbindaddr = 0.0.0.0\n\n[selfphoneng]\nsecret = ${AMI_SECRET}\npermit = 0.0.0.0/0.0.0.0\nread = all\nwrite = all\n',
  );
  phoneConfig(dir, '101', 5070);
  phoneConfig(dir, '102', 5072);

  const problems: string[] = [];
  const ami = new AmiClient({
    host: '127.0.0.1',
    port: AMI_PORT,
    username: 'selfphoneng',
    secret: AMI_SECRET,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    backoffMs: [500],
  });
  const count = async () => {
    const r = await ami.action({ Action: 'MailboxCount', Mailbox: '101@default' });
    return { new: Number(r.NewMessages), old: Number(r.OldMessages) };
  };
  const waitIdle = async () => {
    for (
      let i = 0;
      i < 20 && /PJSIP\/|Local\//.test(await ami.command('core show channels concise'));
      i++
    )
      await sleep(500);
  };
  try {
    docker('rm', '-f', AST, PHONES);
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

    log('starting baresip phones…');
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
    const before = await count();
    if (before.new !== 0) problems.push(`mailbox not empty at start: ${JSON.stringify(before)}`);

    // 102 picks up (auto-answer), then calls 101 like a normal internal call; 101 rings 5 s.
    await ami.action({
      Action: 'Originate',
      Channel: 'PJSIP/102',
      Context: 'sp-from-ext',
      Exten: '101',
      Priority: '1',
      CallerID: '"Bob" <102>',
      Async: 'true',
    });
    let recording = false;
    for (let i = 0; i < 30 && !recording; i++) {
      await sleep(1000);
      recording = /!VoiceMail!/.test(await ami.command('core show channels concise'));
    }
    if (!recording) throw new Error('the unanswered call did not reach VoiceMail');
    log('no answer → voicemail; waiting for the greeting and beep');
    for (let i = 0; i < 40 && !/Recording the message/.test(docker('logs', AST).out); i++)
      await sleep(500);
    await sleep(5000); // five seconds of 880 Hz "speech"
    await ami.command('channel request hangup all');
    await waitIdle();
    await sleep(1000);

    const after = await count();
    log(`mailbox 101: ${after.new} new, ${after.old} old`);
    if (after.new !== 1) problems.push(`expected 1 new message, got ${JSON.stringify(after)}`);
    const inbox = docker('exec', AST, 'ls', '/var/spool/asterisk/voicemail/default/101/INBOX').out;
    if (!/msg0000\.wav/.test(inbox) || !/msg0000\.txt/.test(inbox))
      problems.push(`no msg0000.wav/.txt in INBOX: ${inbox}`);
    const meta = docker(
      'exec',
      AST,
      'cat',
      '/var/spool/asterisk/voicemail/default/101/INBOX/msg0000.txt',
    ).out;
    const secs = Number(/^duration=(\d+)/m.exec(meta)?.[1]);
    if (!/^callerid=.*<102>/m.test(meta) || !(secs >= 2))
      problems.push(`unexpected message metadata:\n${meta}`);

    // The phone's light: baresip prints the NOTIFY body it gets for its MWI subscription.
    let mwiOn = false;
    for (let i = 0; i < 10 && !mwiOn; i++) {
      mwiOn = /Messages-Waiting:\s*yes/i.test(readFileSync(join(dir, 'phone-101', 'log'), 'utf8'));
      if (!mwiOn) await sleep(1000);
    }
    if (!mwiOn) problems.push('101 never got Messages-Waiting: yes');
    else log('101 MWI on');

    // *97 from 101: log in with the PIN, press 1 to hear the new message. The trailing pauses
    // keep the caller side up (the call ends when SendDTMF returns).
    await ami.action({
      Action: 'Originate',
      Channel: 'Local/*97@sp-from-ext',
      Application: 'SendDTMF',
      Data: `${'w'.repeat(6)}${PIN}#${'w'.repeat(16)}1${'w'.repeat(60)}`,
      Variable: '__SP_EXT=101',
      Async: 'true',
    });
    let played = false;
    for (let i = 0; i < 60 && !played; i++) {
      await sleep(500);
      played = /Playing '[^']*voicemail\/default\/101\/INBOX\/msg0000/.test(
        docker('logs', AST).out,
      );
    }
    if (!played) problems.push('*97 did not play msg0000');
    else log('*97 is playing the message');
    await sleep(3000);
    await ami.command('channel request hangup all');
    await waitIdle();
    await sleep(1000);
    const heard = await count();
    if (heard.new !== 0 || heard.old !== 1)
      problems.push(`after *97 expected 0 new / 1 old, got ${JSON.stringify(heard)}`);
    for (let i = 0; i < 10; i++) {
      const lines = readFileSync(join(dir, 'phone-101', 'log'), 'utf8').match(
        /Messages-Waiting:\s*\w+/gi,
      );
      if (lines?.at(-1)?.toLowerCase().endsWith('no')) break;
      if (i === 9) problems.push(`101 MWI did not turn off (last: ${lines?.at(-1)})`);
      await sleep(1000);
    }

    // eslint-disable-next-line no-control-regex -- strips Asterisk's ANSI colors
    const plainLog = docker('logs', AST).out.replace(/\x1b\[[0-9;]*m/g, '');
    problems.push(
      ...plainLog
        .split('\n')
        .filter((l) => /ERROR\[/.test(l))
        .map((l) => `log: ${l.trim()}`),
    );
  } catch (e) {
    problems.push((e as Error).message);
  } finally {
    if (problems.length) log(`asterisk log (tail):\n${docker('logs', '--tail', '60', AST).out}`);
    if (problems.length)
      for (const e of ['101', '102'])
        log(`phone ${e} log (tail):
${docker('exec', PHONES, 'tail', '-n', '25', `/phones/phone-${e}/log`).out}`);
    ami.stop();
    docker('rm', '-f', PHONES, AST);
    docker('network', 'rm', NET);
    rmSync(dir, { recursive: true, force: true });
  }
  if (problems.length) {
    console.log('FAIL voicemail');
    for (const p of problems) console.log(`     ${p}`);
    process.exit(1);
  }
  console.log('ok   voicemail (leave, MWI on, *97 plays, MWI off)');
}

await main();
