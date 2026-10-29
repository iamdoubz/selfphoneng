// SPDX-License-Identifier: AGPL-3.0-or-later
// Asterisk upgrade check (01 §2): boot the pinned image and measure each behaviour in verified.ts,
// then list every one that moved and what depends on it. A second Asterisk plays a provider on
// TLS with a certificate from our own CA for "provider.test", so the qualify check sees a real
// host name. Needs Docker and the image built from asterisk/Dockerfile (ASTERISK_IMAGE, default
// "selfphoneng-asterisk").
// Usage: pnpm test:asterisk-upgrade
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AmiClient } from '../../src/ami/client.ts';
import { field, type AmiMessage } from '../../src/ami/events.ts';
import { FACTS, VERIFIED_ASTERISK, pinnedAsterisk, type Fact } from './verified.ts';
import { testManagerConf } from './manager-conf.ts';

const IMAGE = process.env.ASTERISK_IMAGE ?? 'selfphoneng-asterisk';
const GOLDEN = fileURLToPath(
  new URL('../../src/generator/__golden__/one-user/expected', import.meta.url),
);
const NET = 'sp-upgrade';
const PBX = 'sp-upgrade-pbx';
const PROVIDER = 'sp-upgrade-provider';
const HOST = 'provider.test';
const AMI_PORT = 15040;
const AMI_SECRET = 'upgrade-test-secret';
const SUB = { user: 'upgrade', pass: 'UpgradeSecret42' };
const RISKY = ['app_system', 'func_shell', 'app_disa', 'res_agi', 'app_externalivr'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (...args: string[]) => {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const log = (...a: unknown[]) => console.log('[upgrade-test]', ...a);
async function waitFor(what: string, fn: () => Promise<boolean>, seconds = 60) {
  for (let i = 0; i < seconds; i++) {
    if (await fn()) return;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A CA, and a certificate from it for HOST: what the PBX trusts and the provider shows. */
function certificates(dir: string) {
  const r = docker(
    'run',
    '--rm',
    '-v',
    `${dir}:/out`,
    '--entrypoint',
    'sh',
    IMAGE,
    '-c',
    [
      'cd /out',
      'openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=sp-upgrade-ca -keyout ca.key -out ca.pem',
      `openssl req -newkey rsa:2048 -nodes -subj /CN=${HOST} -keyout privkey.pem -out host.csr`,
      `printf 'subjectAltName=DNS:${HOST}' > host.ext`,
      'openssl x509 -req -in host.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 1 -extfile host.ext -out fullchain.pem',
      'chmod 644 *',
    ].join(' && '),
  );
  if (!r.ok) throw new Error(`certificates: ${r.out}`);
}

const tlsTransport = (name: string, port: number, client: boolean) => `
[${name}]
type = transport
protocol = tls
bind = 0.0.0.0:${port}
cert_file = /tls/fullchain.pem
priv_key_file = /tls/privkey.pem
method = tlsv1_2
${client ? 'verify_server = yes\nca_list_file = /tls/ca.pem\n' : ''}`;

/** The provider: TLS only, one account that may register. */
const providerPjsip = `${tlsTransport('transport-tls', 5061, false)}
[${SUB.user}]
type = endpoint
context = default
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

/**
 * Added to the one-user golden config: a trunk to the provider by name over TLS. The registration
 * is the control (REGISTER verifies the name on every version we know); the AOR's qualify is the
 * fact being measured.
 */
const pbxPjsip = `${tlsTransport('sp-upgrade-tls', 5062, true)}
[sp-upgrade-auth]
type = auth
auth_type = userpass
username = ${SUB.user}
password = ${SUB.pass}

[sp-upgrade-reg]
type = registration
transport = sp-upgrade-tls
outbound_auth = sp-upgrade-auth
server_uri = sip:${HOST}:5061;transport=tls
client_uri = sip:${SUB.user}@${HOST}:5061;transport=tls
contact_user = ${SUB.user}
retry_interval = 5

[sp-upgrade-trunk]
type = aor
contact = sip:${HOST}:5061;transport=tls
qualify_frequency = 5

[sp-upgrade-trunk]
type = endpoint
transport = sp-upgrade-tls
outbound_auth = sp-upgrade-auth
aors = sp-upgrade-trunk
context = sp-upgrade-test
`;

const pbxDialplan = `
[sp-upgrade-test]
exten => s,1,Answer()
 same => n,Hangup()
`;

async function main() {
  const pinned = pinnedAsterisk();
  const tls = mkdtempSync(join(tmpdir(), 'sp-upgrade-tls-'));
  const pbxConf = mkdtempSync(join(tmpdir(), 'sp-upgrade-pbx-'));
  const provConf = mkdtempSync(join(tmpdir(), 'sp-upgrade-prov-'));
  cpSync(GOLDEN, pbxConf, { recursive: true });
  appendFileSync(join(pbxConf, 'pjsip_selfphoneng.conf'), pbxPjsip);
  appendFileSync(join(pbxConf, 'extensions_selfphoneng.conf'), pbxDialplan);
  for (const f of readdirSync(GOLDEN))
    writeFileSync(join(provConf, f), f === 'pjsip_selfphoneng.conf' ? providerPjsip : '');
  writeFileSync(join(pbxConf, 'manager.conf.template'), testManagerConf());

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
      '-v',
      `${tls}:/tls:ro`,
      IMAGE,
    );
  const booted = (name: string) =>
    waitFor(
      `${name} to boot`,
      async () => docker('exec', name, 'asterisk', '-rx', 'core waitfullybooted').ok,
    );

  const seen = {} as Record<Fact, boolean>;
  const problems: string[] = [];
  try {
    docker('rm', '-f', PBX, PROVIDER);
    docker('network', 'create', NET);
    certificates(tls);
    const prov = asterisk(PROVIDER, provConf, ['--network-alias', HOST]);
    if (!prov.ok) throw new Error(`provider: ${prov.out}`);
    await booted(PROVIDER);
    const pbx = asterisk(PBX, pbxConf, [
      '-p',
      `127.0.0.1:${AMI_PORT}:5038`,
      '-v',
      `${join(pbxConf, 'manager.conf.template')}:/etc/asterisk/manager.conf.template:ro`,
    ]);
    if (!pbx.ok) throw new Error(`pbx: ${pbx.out}`);
    await booted(PBX);

    const running = docker('exec', PBX, 'asterisk', '-V').out.trim();
    if (running !== `Asterisk ${pinned}`)
      throw new Error(
        `the image runs "${running}" but asterisk/Dockerfile pins ${pinned}: rebuild it ` +
          `(docker build -t ${IMAGE} asterisk)`,
      );
    log(`${running}, last verified on ${VERIFIED_ASTERISK}`);

    ami.start();
    await new Promise((r) => ami.once('connected', r));
    const cli = (cmd: string) => ami.command(cmd);

    const modules = await Promise.all(RISKY.map((m) => cli(`module show like ${m}`)));
    seen.riskyModulesGone = modules.every((o) => /\b0 modules loaded/.test(o));
    const ep101 = await cli('pjsip show endpoint 101');
    seen.mwiSubscribeReplaces = /mwi_subscribe_replaces_unsolicited\s*:\s*yes/.test(ep101);
    // set_var lines show as their own rows: " __SP_DIRECTION   : internal".
    seen.setVarKeepsUnderscores = /^\s*__SP_DIRECTION\s*:\s*internal\s*$/m.test(ep101);
    const commands = await cli('manager show commands');
    seen.voicemailMoveRemove =
      /\bVoicemailMove\b/.test(commands) && /\bVoicemailRemove\b/.test(commands);

    // CDR: one Local call through the test context.
    const cdr = new Promise<AmiMessage>((r) => ami.once('event:Cdr', r));
    await cli('channel originate Local/s@sp-upgrade-test application Wait 1');
    const m = await Promise.race([
      cdr,
      sleep(15_000).then(() => {
        throw new Error('no Cdr event within 15 s of a call');
      }),
    ]);
    seen.cdrLinkedId = !!field(m, 'LinkedID');
    const start = field(m, 'StartTime') ?? '';
    seen.cdrTimesUtcNoZone =
      /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(start) &&
      Math.abs(Date.parse(`${start.replace(' ', 'T')}Z`) - Date.now()) < 120_000;

    // TLS: the registration must work first, or the qualify answer says nothing.
    await waitFor(
      'the TLS registration to the provider (the control)',
      async () => /sp-upgrade-reg\S*\s.*Registered/.test(await cli('pjsip show registrations')),
      45,
    ).catch(async (e: Error) => {
      throw new Error(`${e.message}:\n${await cli('pjsip show registrations')}`);
    });
    let contacts = '';
    for (let i = 0; i < 20; i++) {
      contacts = await cli('pjsip show contacts');
      if (/sp-upgrade-trunk\/\S+\s.*\b(Avail|Unavail)/.test(contacts)) break;
      await sleep(1000);
    }
    seen.tlsQualifyByHostname = /sp-upgrade-trunk\/\S+\s.*\bAvail\b/.test(contacts);
    if (!seen.tlsQualifyByHostname) {
      const why = docker('logs', PBX)
        // eslint-disable-next-line no-control-regex -- strips Asterisk's ANSI colors
        .out.replace(/\x1b\[[0-9;]*m/g, '')
        .split('\n');
      const line = contacts.split('\n').find((l) => l.includes('sp-upgrade-trunk'));
      log('qualify over TLS failed:', line);
      for (const l of why
        .filter((x) => /sp-upgrade-trunk|identity|EUNSUP|qualif/i.test(x))
        .slice(-4))
        log(l.trim());
    }

    const listed = await ami.actionList({ Action: 'PJSIPShowContacts' });
    seen.staticContactsInShowContacts = listed.some((x) => x.Aor === 'sp-upgrade-trunk');
    const detail = await ami.actionList({
      Action: 'PJSIPShowEndpoint',
      Endpoint: 'sp-upgrade-trunk',
    });
    seen.endpointShowsContactStatus = detail.some(
      (x) => x.Event === 'ContactStatusDetail' && x.AOR === 'sp-upgrade-trunk',
    );
  } catch (e) {
    problems.push((e as Error).message);
  } finally {
    ami.stop();
    docker('rm', '-f', PBX, PROVIDER);
    docker('network', 'rm', NET);
    for (const d of [tls, pbxConf, provConf]) rmSync(d, { recursive: true, force: true });
  }

  const moved = (Object.keys(FACTS) as Fact[]).filter(
    (k) => k in seen && seen[k] !== FACTS[k].expect,
  );
  for (const k of Object.keys(FACTS) as Fact[])
    console.log(
      `${!(k in seen) ? '?   ' : moved.includes(k) ? 'MOVED' : 'ok   '} ${k}: ${k in seen ? seen[k] : 'not measured'}`,
    );
  for (const k of moved)
    problems.push(
      `${k} was ${FACTS[k].expect} on ${VERIFIED_ASTERISK}, is ${seen[k]} on ${pinned}: ` +
        `${FACTS[k].what}. Depends on it: ${FACTS[k].where}`,
    );
  if (problems.length) {
    console.log('FAIL asterisk upgrade');
    for (const p of problems) console.log(`     ${p}`);
    process.exit(1);
  }
  console.log(
    pinned === VERIFIED_ASTERISK
      ? `ok   asterisk ${pinned}: every fact as recorded`
      : `ok   asterisk ${pinned}: nothing moved since ${VERIFIED_ASTERISK}; set VERIFIED_ASTERISK in verified.ts`,
  );
}

await main();
