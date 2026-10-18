// SPDX-License-Identifier: AGPL-3.0-or-later
// M3-T5 acceptance: a fresh install taken to "inbound and outbound calls work" using only the
// setup wizard, against a fake voip.ms (a second Asterisk that registers the sub-account, calls
// our DID like voip.ms does, and records what our outbound calls look like).
// Needs `m2-live.mjs up` and the api on a FRESH database (initial admin password).
// Usage: node scripts/e2e/m3-t5.mjs <baseUrl> <adminEmail> <initialPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './cdp.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const PROVIDER = 'sp-live-provider';
const PHONE = 'sp-live-phone101';
const IMAGE = process.env.ASTERISK_IMAGE ?? 'selfphoneng-asterisk';
const SUB = { user: '123456_pbx', pass: 'ProviderSecret42' }; // the fake provider's test account
const NEW_PW = 'correct-horse-battery-staple';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...a) => {
  const r = spawnSync('docker', a, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};
const cli = (name, cmd) => docker('exec', name, 'asterisk', '-rx', cmd).out;
async function until(what, fn, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await fn()) return;
    await sleep(500);
  }
  throw new Error(`timed out: ${what}`);
}
const [base, email, initialPw, shotsDir] = process.argv.slice(2);

// ── the fake voip.ms ──
const conf = mkdtempSync(join(tmpdir(), 'sp-provider-'));
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
  join(conf, 'pjsip_selfphoneng.conf'),
  `[transport-udp]\ntype = transport\nprotocol = udp\nbind = 0.0.0.0:5060\n\n` +
    `[${SUB.user}]\ntype = endpoint\ncontext = provider-in\ndisallow = all\nallow = ulaw\nauth = ${SUB.user}-auth\naors = ${SUB.user}\n\n` +
    `[${SUB.user}-auth]\ntype = auth\nauth_type = userpass\nusername = ${SUB.user}\npassword = ${SUB.pass}\n\n` +
    `[${SUB.user}]\ntype = aor\nmax_contacts = 1\nremove_existing = yes\n`,
);
writeFileSync(
  join(conf, 'extensions_selfphoneng.conf'),
  // Calls to our DID use a 10-digit Request-URI, like voip.ms (06 §3).
  `[provider-out]\nexten => _X.,1,Set(CALLERID(all)="Mobile" <3125559999>)\n same => n,Dial(PJSIP/\${EXTEN}@${SUB.user},30)\n\n` +
    `[provider-echo]\nexten => s,1,Answer()\n same => n,Echo()\n\n` +
    `[provider-in]\nexten => _X.,1,Set(GLOBAL(LAST_IN)=to=\${EXTEN} rpid=\${PJSIP_HEADER(read,Remote-Party-ID)})\n same => n,Answer()\n same => n,Echo()\n`,
);
docker('rm', '-f', PROVIDER, PHONE);
assert.ok(
  docker(
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
  ).ok,
);
await until(
  'provider boot',
  async () => docker('exec', PROVIDER, 'asterisk', '-rx', 'core waitfullybooted').ok,
);
const providerIp = docker(
  'inspect',
  '-f',
  `{{(index .NetworkSettings.Networks "${NET}").IPAddress}}`,
  PROVIDER,
).out;

const p = await launch({ shotsDir });
const text = () => p.evaluate('document.body.innerText');
const step = async (n, title) => {
  await p.waitFor(
    `document.querySelector('#step-title')?.textContent === '${n}. ${title}'`,
    `step ${n}`,
    20000,
  );
};
/** Waits for the field (steps load their data first), then fills it. */
const fill = async (label, value) => {
  await p.waitFor(
    `[...document.querySelectorAll('label')].some(l => l.textContent.trim().startsWith(${JSON.stringify(label)}))`,
    label,
    20000,
  );
  await p.fill(label, value);
};
const clickNext = () => p.click('Next');
try {
  // 1. Password (forced change on first sign-in)
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', initialPw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/change-password'`);
  await p.fill('Current password', initialPw);
  await p.fill('New password', NEW_PW);
  await p.fill('Repeat new password', NEW_PW);
  await p.click('Change password');
  await p.waitFor(`location.pathname === '/setup'`, 'wizard opens');
  await step(1, 'Password');
  await clickNext();

  // 2. Company
  await step(2, 'Company');
  await fill('Company name', 'Acme Dental');
  await p.click('Save and continue');

  // 3. Network (documentation address; Docker's 172.16/12 stays a local net). Saving changes the
  // SIP transports, so the wizard restarts telephony.
  await step(3, 'Network');
  await fill('Public IP address', '203.0.113.10');
  await p.evaluate(
    `[...document.querySelectorAll('label')].find(l => l.textContent.includes("I've done this")).querySelector('input').click(), true`,
  );
  await p.click('Save and continue');
  await step(4, 'Email');
  const restarted = (await text()).includes('Telephony restarted');
  console.log(`network saved${restarted ? '; telephony restarted' : ''}`);
  assert.match(
    cli(AST, 'pjsip show transport transport-udp'),
    /external_media_address\s*:\s*203\.0\.113\.10/,
  );

  // 4. Email: skipped
  await p.click('Skip for now');

  // 5. Trunk
  await step(5, 'Trunk');
  await fill('Server', providerIp);
  await fill('Sub-account username', SUB.user);
  await fill('Password', SUB.pass);
  await p.click('Create trunk');
  await p.waitFor(`document.body.innerText.includes('Saved.')`, 'trunk saved');
  await p.waitFor(
    `![...document.querySelectorAll('button')].find(b => b.textContent === 'Next').disabled`,
    'trunk Registered unlocks Next',
    90000,
  );
  await p.shot('m3-t5-05-trunk');
  console.log('trunk Registered');
  await clickNext();

  // 6. Numbers
  await step(6, 'Phone numbers');
  await fill('Phone number', '(312) 555-1234');
  await p.click('Add number');
  await p.waitFor(`document.body.innerText.includes('✓ (312) 555-1234')`, 'number added');
  await clickNext();

  // 7. Users
  await step(7, 'Users');
  for (const [aria, value] of [
    ['Name 1', 'Dan Doe'],
    ['Email 1', 'dan@example.com'],
  ])
    await p.evaluate(`(() => {
      const el = document.querySelector('input[aria-label="${aria}"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  await p.click('Add users');
  await p.waitFor(`document.body.innerText.includes('shown only now')`, 'temporary password');
  await p.shot('m3-t5-07-users');
  const ext = /(\d{3,6})\s+Dan Doe/.exec(await text())?.[1];
  assert.ok(ext, 'Dan got an extension');
  await p.waitFor(`document.body.innerText.includes('✓ ${ext} Dan Doe')`);
  await clickNext();

  // 8. Main number → "Ring everyone" (M6: a ring group of all users; Dan is the only one)
  await step(8, 'Main number');
  const label = 'When someone calls (312) 555-1234 (Main line), ring:';
  await p.click('Ring everyone');
  await p.waitFor(
    `document.querySelector('select[aria-label="${label}: type"]')?.value === 'ring_group' && document.querySelector('select[aria-label="${label}: ring group"]')?.selectedOptions[0]?.textContent.includes('Everyone')`,
    'ring group Everyone picked',
  );
  await p.click('Save and continue');

  // 9. Emergency: Next stays locked until a default E911 caller ID is saved.
  await step(9, 'Emergency');
  assert.ok(
    await p.evaluate(
      `[...document.querySelectorAll('button')].find(b => b.textContent === 'Next').disabled`,
    ),
  );
  const didId = await p.evaluate(
    `[...document.querySelectorAll('option')].find(o => o.textContent.startsWith('(312) 555-1234')).value`,
  );
  await fill('Default emergency caller ID', didId);
  await p.click('Save');
  await p.waitFor(
    `![...document.querySelectorAll('button')].find(b => b.textContent === 'Next').disabled`,
    'Next unlocked',
  );
  await clickNext();

  // 10. Done
  await step(10, 'Done');
  await p.click('Finish');
  await p.waitFor(`location.pathname === '/admin'`, 'dashboard after finishing');
  await p.waitFor(
    `/Trunks up\\s*1 \\/ 1/.test(document.body.innerText)`,
    'trunk up on the dashboard',
  );
  await p.shot('m3-t5-10-dashboard');
  console.log('wizard finished');

  // ── Calls work ──
  const cookie = await (async () => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'selfphoneng' },
      body: JSON.stringify({ email, password: NEW_PW }),
    });
    return r.headers.get('set-cookie').split(';')[0];
  })();
  const exts = await (await fetch(`${base}/api/extensions`, { headers: { cookie } })).json();
  const dan = exts.items.find((e) => e.number === ext);
  const creds = await (
    await fetch(`${base}/api/extensions/${dan.id}/sip-credentials`, { headers: { cookie } })
  ).json();
  const dir = mkdtempSync(join(tmpdir(), 'sp-phone-'));
  mkdirSync(join(dir, 'p'));
  writeFileSync(
    join(dir, 'p', 'config'),
    'sip_listen 0.0.0.0:5070\nmodule_path /usr/lib/baresip/modules\nmodule g711.so\nmodule ausine.so\nmodule aufile.so\nmodule menu.so\nmodule account.so\naudio_source ausine,440\nausrc_srate 48000\nauplay_srate 48000\naudio_player aufile,/phone/p/heard.wav\naudio_alert aufile,/dev/null\n',
  );
  writeFileSync(
    join(dir, 'p', 'accounts'),
    `<sip:${ext}@${AST};transport=udp>;auth_pass=${creds.password};answermode=auto;audio_codecs=PCMU\n`,
  );
  assert.ok(
    docker(
      'run',
      '-d',
      '--rm',
      '--name',
      PHONE,
      '--network',
      NET,
      '-v',
      `${dir}:/phone`,
      'debian:trixie-slim',
      'sh',
      '-c',
      'apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends baresip-core >/dev/null 2>&1 && baresip -f /phone/p > /phone/p/log 2>&1',
    ).ok,
  );
  await until(
    `phone ${ext} registers`,
    async () => new RegExp(`${ext}/sip:.*Avail`).test(cli(AST, 'pjsip show contacts')),
    180,
  );

  const bothUp = () => {
    const up = cli(AST, 'core show channels concise')
      .split('\n')
      .filter((l) => l.includes('!Up!'));
    return (
      up.some((l) => l.startsWith(`PJSIP/${ext}-`)) && up.some((l) => l.startsWith('PJSIP/trunk-'))
    );
  };
  // Inbound: a "mobile" calls the DID.
  cli(PROVIDER, 'channel originate Local/3125551234@provider-out extension s@provider-echo');
  await until('inbound call answered by Dan', async () => bothUp(), 30);
  await p.waitFor(
    `/On a call\\s*1/.test(document.body.innerText)`,
    'dashboard shows the call',
    10000,
  );
  await p.shot('m3-t5-11-inbound-call');
  console.log(`inbound: (312) 555-1234 rang ${ext}, answered`);
  cli(AST, 'channel request hangup all');
  await sleep(2000);

  // Outbound: Dan dials a 10-digit number.
  cli(AST, `channel originate PJSIP/${ext} extension 3125550000@sp-from-ext`);
  await until('outbound call connected', async () => bothUp(), 30);
  const lastIn = /LAST_IN=(.*)/.exec(cli(PROVIDER, 'dialplan show globals'))?.[1] ?? '';
  assert.match(lastIn, /^to=13125550000 /, 'provider got 11 digits');
  assert.match(lastIn, /sip:13125551234@/, 'caller ID is the DID');
  console.log(`outbound: provider received ${lastIn}`);
  cli(AST, 'channel request hangup all');
  assert.deepEqual(p.consoleErrors, [], 'no console errors');
  console.log('M3-T5 (wizard → calls work): PASS');
} catch (e) {
  await p.shot('m3-t5-FAILED').catch(() => {});
  console.error('FAIL:', e.message, '\nconsole:', p.consoleErrors);
  process.exitCode = 1;
} finally {
  await p.close();
  docker('rm', '-f', PHONE);
}
