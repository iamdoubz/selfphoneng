// SPDX-License-Identifier: AGPL-3.0-or-later
// M3 trunk checks against a fake provider: a second Asterisk plays voip.ms (a sub-account that
// registers), our generated config is the PBX. Everything runs on a private Docker bridge network.
// M3-T1: the good trunk registers, the one with a wrong password is rejected, and the AMI
// session can be recorded for the live-state tests.
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
    dids: [],
    extensions: [],
    trunks: [trunk(GOOD, 'voip.ms', SUB.pass), trunk(BAD, 'wrong password', 'NotThePassword1')],
  };
}

/** The fake voip.ms: one sub-account that may register. */
const PROVIDER_PJSIP = `[transport-udp]
type = transport
protocol = udp
bind = 0.0.0.0:5060

[${SUB.user}]
type = endpoint
context = provider-in
disallow = all
allow = ulaw
auth = ${SUB.user}-auth
aors = ${SUB.user}

[${SUB.user}-auth]
type = auth
auth_type = userpass
username = ${SUB.user}
password = ${SUB.pass}

[${SUB.user}]
type = aor
max_contacts = 1
remove_existing = yes
`;

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
    writeFileSync(join(provConf, f), f === 'pjsip_selfphoneng.conf' ? PROVIDER_PJSIP : '');
  }
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
  const booted = async (name: string) =>
    waitFor(
      `${name} to boot`,
      async () => docker('exec', name, 'asterisk', '-rx', 'core waitfullybooted').ok,
    );

  try {
    docker('rm', '-f', PBX, PROVIDER);
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

    // eslint-disable-next-line no-control-regex -- strips Asterisk's ANSI colors
    const plainLog = docker('logs', PBX).out.replace(/\x1b\[[0-9;]*m/g, '');
    const errors = plainLog.split('\n').filter((l) => /ERROR\[/.test(l));
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
    docker('rm', '-f', PBX, PROVIDER);
    docker('network', 'rm', NET);
    rmSync(dir, { recursive: true, force: true });
  }
  if (problems.length) {
    console.log('FAIL trunks');
    for (const p of problems) console.log(`     ${p}`);
    process.exit(1);
  }
  console.log('ok   trunks (registration, rejection, qualify)');
}

await main();
