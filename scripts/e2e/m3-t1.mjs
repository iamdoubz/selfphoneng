// SPDX-License-Identifier: AGPL-3.0-or-later
// M3-T1 in a browser against a fake voip.ms: a second Asterisk on the m2-live network accepts the
// sub-account's registration. Create the trunk in the UI, see it turn Registered, press Test.
// Needs `m2-live.mjs up` and the api started as described there.
// Usage: node scripts/e2e/m3-t1.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './cdp.mjs';

const NET = 'sp-live';
const PROVIDER = 'sp-live-provider';
const IMAGE = process.env.ASTERISK_IMAGE ?? 'selfphoneng-asterisk';
const SUB = { user: '123456_pbx', pass: 'ProviderSecret42' }; // the fake provider's test account
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...a) => {
  const r = spawnSync('docker', a, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};
const [base, email, pw, shotsDir] = process.argv.slice(2);

const conf = mkdtempSync(join(tmpdir(), 'sp-provider-'));
for (const f of [
  'rtp_selfphoneng.conf',
  'extensions_globals_selfphoneng.conf',
  'extensions_selfphoneng.conf',
  'voicemail_selfphoneng.conf',
  'queues_selfphoneng.conf',
  'musiconhold_selfphoneng.conf',
  'confbridge_selfphoneng.conf',
])
  writeFileSync(join(conf, f), '');
writeFileSync(
  join(conf, 'pjsip_selfphoneng.conf'),
  `[transport-udp]\ntype = transport\nprotocol = udp\nbind = 0.0.0.0:5060\n\n` +
    `[${SUB.user}]\ntype = endpoint\ncontext = provider-in\ndisallow = all\nallow = ulaw\nauth = ${SUB.user}-auth\naors = ${SUB.user}\n\n` +
    `[${SUB.user}-auth]\ntype = auth\nauth_type = userpass\nusername = ${SUB.user}\npassword = ${SUB.pass}\n\n` +
    `[${SUB.user}]\ntype = aor\nmax_contacts = 1\nremove_existing = yes\n`,
);
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
for (
  let i = 0;
  i < 60 && !docker('exec', PROVIDER, 'asterisk', '-rx', 'core waitfullybooted').ok;
  i++
)
  await sleep(500);
// An IP, not the container name: the api (on the host) checks that the server name resolves.
const ip = docker(
  'inspect',
  '-f',
  `{{(index .NetworkSettings.Networks "${NET}").IPAddress}}`,
  PROVIDER,
).out;
console.log(`fake provider at ${ip}`);

const p = await launch({ shotsDir });
try {
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`);
  await p.click('Trunks');
  await p.waitFor(`document.body.innerText.includes('No trunks yet')`, 'empty trunks page');
  await p.click('New trunk');
  await p.waitFor(`document.body.innerText.includes('Set up voip.ms first')`, 'voip.ms checklist');
  await p.fill('Server', ip);
  await p.fill('Sub-account username', SUB.user);
  await p.fill('Password', SUB.pass);
  await p.shot('m3-t1-01-form');
  await p.click('Create trunk');
  await p.waitFor(`document.body.innerText.includes('Saved.')`, 'saved');
  await p.waitFor(
    `[...document.querySelectorAll('dialog span')].some(s => s.textContent === 'Registered')`,
    'trunk shows Registered',
    90000,
  );
  console.log('trunk shows Registered in the UI');
  await p.click('Test');
  await p.waitFor(
    `document.body.innerText.includes('Registered with ${ip}')`,
    'test result',
    15000,
  );
  await p.shot('m3-t1-02-registered');
  console.log('Test: Registered with', ip);
  await p.click('Close');
  await p.click('Dashboard');
  await p.waitFor(`/Trunks up\\s*1 \\/ 1/.test(document.body.innerText)`, 'dashboard trunk card');
  await p.shot('m3-t1-03-dashboard');
  const onProvider = docker('exec', PROVIDER, 'asterisk', '-rx', 'pjsip show contacts').out;
  assert.match(onProvider, new RegExp(`${SUB.user}/sip:${SUB.user}@`), 'contact on the provider');
  assert.deepEqual(p.consoleErrors, [], 'no console errors');
  console.log('M3-T1 (fake provider): PASS');
} catch (e) {
  await p.shot('m3-t1-FAILED').catch(() => {});
  console.error('FAIL:', e.message, '\nconsole:', p.consoleErrors);
  process.exitCode = 1;
} finally {
  await p.close();
  docker('rm', '-f', PROVIDER);
}
