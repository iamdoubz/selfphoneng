// SPDX-License-Identifier: AGPL-3.0-or-later
// M11-T2: SIP over TLS with SRTP against a fake voip.ms that only speaks TLS. A throwaway CA signs
// the PBX's and the provider's certificates. The admin turns TLS on in Settings → Security (the
// certificate shows), telephony restarts, and a TLS + SRTP trunk is created. While the CA isn't
// trusted the trunk must NOT register (verify_server); once it is, it registers, a call carries
// SRTP both ways (RTP/SAVP + a=crypto in the INVITE, packets counted), and a renewed PBX
// certificate goes live with a res_pjsip reload while that call stays up (scripts/tls-cert.sh).
// Runs on the m2-live setup after m1-t4.mjs; start the api with TLS_DIR=<tlsDir> (an empty dir).
// Usage: node scripts/e2e/m11-t2.mjs <baseUrl> <adminEmail> <adminPassword> <tlsDir> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './cdp.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const PROVIDER = 'sp-live-tlsprov';
const IMAGE = process.env.ASTERISK_IMAGE ?? 'selfphoneng-asterisk';
const SUB = { user: '123456_tls', pass: 'TlsProviderSecret42' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...a) => {
  const r = spawnSync('docker', a, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};
const cli = (c, cmd) => docker('exec', c, 'asterisk', '-rx', cmd).out;
const asRoot = (c, sh) => docker('exec', '-u', '0', c, 'sh', '-c', sh);
/** A container's recent log without Asterisk's color codes. */
// eslint-disable-next-line no-control-regex -- matching ANSI escapes is the point
const logs = (c, since) => docker('logs', '--since', since, c).out.replace(/[[0-9;]*m/g, '');
const ipOf = (c) =>
  docker('inspect', '-f', `{{(index .NetworkSettings.Networks "${NET}").IPAddress}}`, c).out;
async function until(what, fn, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) if (await fn()) return;
  throw new Error(`timed out: ${what}`);
}
const [base, email, pw, tlsDir, shotsDir] = process.argv.slice(2);

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

// 1. The provider: an Asterisk on the m2-live network, TLS added once its IP (the cert's name) is known.
const conf = mkdtempSync(join(tmpdir(), 'sp-tlsprov-'));
for (const f of [
  'rtp_selfphoneng.conf',
  'extensions_globals_selfphoneng.conf',
  'voicemail_selfphoneng.conf',
  'queues_selfphoneng.conf',
  'musiconhold_selfphoneng.conf',
  'confbridge_selfphoneng.conf',
])
  writeFileSync(join(conf, f), '');
writeFileSync(
  join(conf, 'extensions_selfphoneng.conf'),
  '[provider-in]\nexten => _X.,1,Answer()\n same => n,Echo()\n',
);
writeFileSync(join(conf, 'pjsip_selfphoneng.conf'), '');
docker('rm', '-f', PROVIDER);
const run = docker(
  'run',
  '-d',
  '--rm',
  '--name',
  PROVIDER,
  '--network',
  NET,
  '-e',
  'AMI_SECRET=provider',
  '-v',
  `${conf}:/etc/asterisk/selfphoneng`,
  IMAGE,
);
assert.ok(run.ok, run.out);
await until(
  'provider booted',
  () => docker('exec', PROVIDER, 'asterisk', '-rx', 'core waitfullybooted').ok,
);
const providerIp = ipOf(PROVIDER);
const astIp = ipOf(AST);
console.log(`provider ${providerIp}, pbx ${astIp}`);

// 2. Certificates, made with the image's openssl: CA, provider (IP name), PBX now and "renewed".
const certs = mkdtempSync(join(tmpdir(), 'sp-tlscerts-'));
const mk = docker(
  'run',
  '--rm',
  '-v',
  `${certs}:/out`,
  '--entrypoint',
  'sh',
  IMAGE,
  '-c',
  `set -e; cd /out
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj /CN=SelfPhoneNG-test-CA -keyout ca.key -out ca.crt 2>/dev/null
mk() { openssl req -newkey rsa:2048 -nodes -subj /CN=$1 -keyout $1.key -out $1.csr 2>/dev/null
  echo "subjectAltName=$2" > $1.ext
  openssl x509 -req -in $1.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days $3 -extfile $1.ext -out $1.crt 2>/dev/null; }
mk provider IP:${providerIp} 30; mk pbx1 DNS:pbx.test 30; mk pbx2 DNS:pbx.test 90
chmod 644 *`,
);
assert.ok(mk.ok, mk.out);

copyFileSync(join(certs, 'provider.crt'), join(conf, 'provider.crt'));
copyFileSync(join(certs, 'provider.key'), join(conf, 'provider.key'));
writeFileSync(
  join(conf, 'pjsip_selfphoneng.conf'),
  `[transport-tls]\ntype = transport\nprotocol = tls\nbind = 0.0.0.0:5061\n` +
    `cert_file = /etc/asterisk/selfphoneng/provider.crt\npriv_key_file = /etc/asterisk/selfphoneng/provider.key\nmethod = tlsv1_2\n\n` +
    `[${SUB.user}]\ntype = endpoint\ntransport = transport-tls\ncontext = provider-in\ndisallow = all\nallow = ulaw\n` +
    `media_encryption = sdes\nauth = ${SUB.user}-auth\naors = ${SUB.user}\n\n` +
    `[${SUB.user}-auth]\ntype = auth\nauth_type = userpass\nusername = ${SUB.user}\npassword = ${SUB.pass}\n\n` +
    `[${SUB.user}]\ntype = aor\nmax_contacts = 1\nremove_existing = yes\n`,
);
cli(PROVIDER, 'module reload res_pjsip.so'); // it booted with no transports: adding one is fine
cli(PROVIDER, 'dialplan reload');
assert.match(
  cli(PROVIDER, 'pjsip show transports'),
  /transport-tls\s+tls/,
  'provider listens on TLS',
);

/** The PBX certificate where the api (TLS_DIR) and Asterisk look, as tls-cert.sh puts it. */
function installPbxCert(name) {
  copyFileSync(join(certs, `${name}.crt`), join(tlsDir, 'fullchain.pem'));
  copyFileSync(join(certs, `${name}.key`), join(tlsDir, 'privkey.pem'));
  asRoot(AST, 'mkdir -p /var/lib/selfphoneng/tls');
  docker('cp', join(certs, `${name}.crt`), `${AST}:/var/lib/selfphoneng/tls/fullchain.pem`);
  docker('cp', join(certs, `${name}.key`), `${AST}:/var/lib/selfphoneng/tls/privkey.pem`);
  // Asterisk re-reads them only when the mtime changes; docker cp keeps the source's, and both
  // certs were made in the same second. tls-cert.sh's install gives them a fresh one.
  asRoot(AST, 'chmod 644 /var/lib/selfphoneng/tls/* && touch /var/lib/selfphoneng/tls/*');
}
/** The serial of the certificate the PBX presents on 5061, asked from the provider's container. */
const servedSerial = () =>
  docker(
    'exec',
    PROVIDER,
    'sh',
    '-c',
    `echo | openssl s_client -connect ${astIp}:5061 -servername pbx.test 2>/dev/null | openssl x509 -noout -serial`,
  ).out;
const serialOf = (name) =>
  docker(
    'run',
    '--rm',
    '-v',
    `${certs}:/out`,
    '--entrypoint',
    'openssl',
    IMAGE,
    'x509',
    '-noout',
    '-serial',
    '-in',
    `/out/${name}.crt`,
  ).out;

const p = await launch({ shotsDir });
try {
  // 3. Settings → Security: no certificate yet, then pbx1 shows; turn TLS on.
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`);
  await p.goto(`${base}/admin/settings/security`);
  await p.waitFor(`document.body.innerText.includes('No certificate')`, 'no certificate yet');
  installPbxCert('pbx1');
  await p.goto(`${base}/admin/settings/security`);
  await p.waitFor(
    `document.querySelector('[aria-label="TLS certificate"]')?.textContent.startsWith('Certificate for pbx.test')`,
    'certificate shown',
  );
  await p.evaluate(`[...document.querySelectorAll('label')]
    .find((l) => l.textContent.trim() === 'Accept SIP over TLS')
    .querySelector('input').click()`);
  await p.click('Save');
  await p.waitFor(`document.body.innerText.includes('Saved.')`, 'saved');
  await p.shot('m11-t2-01-security');
  assert.equal((await api('GET', '/api/settings'))['sip.tlsEnabled'], true);

  // New transport: restart telephony (01 §4.3).
  await sleep(1500);
  await api('POST', '/api/system/asterisk/restart?now=true', {});
  await until(
    'restarted',
    async () => {
      const s = await api('GET', '/api/system/status').catch(() => null);
      return s?.ami.connected && !s.restartRequired;
    },
    60000,
  );
  await until('transport-tls up', () =>
    /transport-tls\s+tls/.test(cli(AST, 'pjsip show transports')),
  );
  assert.equal(servedSerial(), serialOf('pbx1'), 'PBX serves pbx1');
  console.log('TLS on: PBX serves its certificate on 5061');

  // 4. A TLS + SRTP trunk. The test CA isn't trusted yet: verify_server must refuse the provider.
  const trunk = await api('POST', '/api/trunks', {
    name: 'voip.ms TLS',
    serverHost: providerIp,
    serverPort: 5061,
    transport: 'tls',
    srtp: true,
    username: SUB.user,
    password: SUB.pass,
  });
  /** This trunk's registration line (earlier scripts may have other trunks registered). */
  const registered = () =>
    new RegExp(`trunk-${trunk.id}-reg\\S*\\s+\\S+\\s+Registered`).test(
      cli(AST, 'pjsip show registrations'),
    );
  await until('verify error logged', () =>
    /verify_log_result: Transport 'transport-tls'/.test(logs(AST, '60s')),
  );
  assert.ok(!registered(), 'untrusted provider: not registered');
  assert.doesNotMatch(cli(PROVIDER, 'pjsip show contacts'), new RegExp(`${SUB.user}/sip:`));
  console.log('untrusted provider certificate refused');

  // Trust the CA (as for voip.ms's Let's Encrypt chain) and register.
  docker('cp', join(certs, 'ca.crt'), `${AST}:/tmp/test-ca.crt`);
  asRoot(AST, 'cat /tmp/test-ca.crt >> /etc/ssl/certs/ca-certificates.crt');
  cli(AST, 'module reload res_pjsip.so');
  cli(AST, `pjsip send register trunk-${trunk.id}-reg`);
  await until('registered over TLS', registered, 60000);
  const test = await api('POST', `/api/trunks/${trunk.id}/test`, {});
  assert.equal(test.detail, `Registered with ${providerIp}`);
  console.log('trunk registered over TLS:', test.detail);

  // 5. A call through the trunk: SRTP offered and used, audio both ways (the provider echoes).
  cli(PROVIDER, 'pjsip set logger on');
  cli(
    AST,
    `channel originate PJSIP/15551234@trunk-${trunk.id} application Playback tt-monkeys&tt-monkeys&tt-monkeys`,
  );
  await until('call up on the provider', () =>
    /PJSIP\/123456_tls-\S+\s+15551234@provider-in:\d+\s+Up/.test(
      cli(PROVIDER, 'core show channels'),
    ),
  );
  const invite = logs(PROVIDER, '30s').split('INVITE sip:15551234@')[1] ?? '';
  assert.match(invite, /m=audio \d+ RTP\/SAVP/, 'SDP offers RTP/SAVP');
  assert.match(invite, /a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:/, 'SDES key in the SDP');
  assert.match(
    logs(PROVIDER, '30s'),
    new RegExp(`Received SIP request \\(\\d+ bytes\\) from TLS:${astIp.replace(/\./g, '\\.')}`),
  );
  await sleep(3000);
  const rx = () =>
    [
      ...cli(AST, 'pjsip show channelstats').matchAll(/ulaw\s+(\d+)\s+\d+\s+\S+\s+\S+\s+(\d+)/g),
    ].map((m) => [Number(m[1]), Number(m[2])]);
  const [[recv, sent]] = rx();
  assert.ok(recv > 50 && sent > 50, `RTP both ways: received ${recv}, sent ${sent}`);
  console.log(`SRTP call up: ${recv} packets in, ${sent} out`);

  // 6. Renewal: pbx2 goes live on a res_pjsip reload, the call stays up.
  installPbxCert('pbx2');
  cli(AST, 'module reload res_pjsip.so');
  await until('pbx2 served', () => servedSerial() === serialOf('pbx2'));
  assert.match(
    cli(PROVIDER, 'core show channels'),
    /PJSIP\/123456_tls-/,
    'call survived the reload',
  );
  const tls = await api('GET', '/api/system/tls');
  assert.ok(Date.parse(tls.notAfter) - Date.now() > 80 * 86_400_000, 'api sees the renewed cert');
  const warn = (await api('GET', '/api/system/warnings')).items.map((w) => w.code);
  assert.ok(!warn.includes('tls_cert'), 'no certificate warning');
  console.log('renewed certificate live after reload, call still up');
  cli(AST, 'channel request hangup all');
  assert.deepEqual(p.consoleErrors, [], 'no console errors');
  console.log('M11-T2: PASS');
} catch (e) {
  await p.shot('m11-t2-FAILED').catch(() => {});
  console.error('FAIL:', e.message, '\nconsole:', p.consoleErrors);
  process.exitCode = 1;
} finally {
  await p.close();
  cli(PROVIDER, 'pjsip set logger off');
  // The provider keeps running until m2-live.mjs down (see m3-t1.mjs).
}
