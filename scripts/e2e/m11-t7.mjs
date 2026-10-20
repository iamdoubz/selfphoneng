// SPDX-License-Identifier: AGPL-3.0-or-later
// M11-T7: what the admin guide (docs/admin-guide/) claims, checked.
// - fail2ban: a phone with the wrong password registers against the real Asterisk; fail2ban's
//   stock `asterisk` filter (fail2ban-regex, Debian's fail2ban) matches those lines of our
//   security.log, with the phone's IP, and CrowdSec's crowdsecurity/asterisk collection parses it.
// - The guide's screenshots are taken from the running app into <imgDir>.
// - Every relative link and image in the guide points at a file that exists.
// Runs on m2-live, after m1-t4.mjs.
// Usage: node scripts/e2e/m11-t7.mjs <baseUrl> <adminEmail> <adminPassword> <imgDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';
import { startPhones } from './phones.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const PHONES = 'sp-live-phones-m11t7';
const GUIDE = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/admin-guide');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...a) => spawnSync('docker', a, { encoding: 'utf8' });
const [base, email, pw, imgDir] = process.argv.slice(2);
const until = async (what, ms, fn) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    assert.ok(Date.now() < end, `timed out: ${what}`);
    await sleep(500);
  }
};

// 1. fail2ban on a real failed registration.
const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-requested-with': 'selfphoneng' },
  body: JSON.stringify({ email, password: pw }),
});
const cookie = login.headers
  .getSetCookie()
  .map((c) => c.split(';')[0])
  .join('; ');
const r = await fetch(`${base}/api/extensions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-requested-with': 'selfphoneng', cookie },
  body: JSON.stringify({ number: '270', name: 'Front Desk' }),
});
assert.equal(r.status, 201, await r.text());
const securityLog = () => docker('exec', AST, 'cat', '/var/log/asterisk/security.log').stdout ?? '';
await until('extension 270 in Asterisk', 30_000, () =>
  /270/.test(docker('exec', AST, 'asterisk', '-rx', 'pjsip show endpoints').stdout),
);
const phones = startPhones({
  name: PHONES,
  net: NET,
  ast: AST,
  phones: [{ ext: '270', password: 'not-the-password', answer: 'auto' }],
});
try {
  await until('failed registrations in security.log', 180_000, () =>
    /ChallengeResponseFailed|InvalidPassword/.test(securityLog()),
  );
  const phoneIp = docker(
    'inspect',
    '-f',
    '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
    PHONES,
  ).stdout.trim();
  const dir = mkdtempSync(join(tmpdir(), 'sp-f2b-'));
  writeFileSync(join(dir, 'security.log'), securityLog());
  const f2b = docker(
    'run',
    '--rm',
    '-v',
    `${dir}:/logs`,
    'debian:trixie-slim',
    'sh',
    '-c',
    'apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends fail2ban >/dev/null 2>&1 && fail2ban-regex --print-all-matched /logs/security.log /etc/fail2ban/filter.d/asterisk.conf',
  );
  const out = f2b.stdout ?? '';
  const matched = Number(/Lines: \d+ lines, \d+ ignored, (\d+) matched/.exec(out)?.[1] ?? 0);
  assert.ok(matched >= 1, `fail2ban matched nothing:\n${out}${f2b.stderr}`);
  assert.ok(out.includes(phoneIp), `fail2ban's matches don't name the phone (${phoneIp}):\n${out}`);
  console.log(`fail2ban: the stock asterisk filter matched ${matched} lines for ${phoneIp}`);

  // CrowdSec: the crowdsecurity/asterisk collection parses the same file.
  const cs = 'sp-crowdsec-m11t7';
  docker('rm', '-f', cs);
  docker(
    'run',
    '-d',
    '--name',
    cs,
    '-e',
    'CROWDSEC_BYPASS_DB_VOLUME_CHECK=true',
    '-e',
    'COLLECTIONS=crowdsecurity/asterisk',
    '-v',
    `${dir}:/logs`,
    'crowdsecurity/crowdsec:latest',
  );
  try {
    await until(
      'CrowdSec up',
      120_000,
      () => docker('exec', cs, 'cscli', 'lapi', 'status').status === 0,
    );
    const explain = docker(
      'exec',
      cs,
      'cscli',
      'explain',
      '--file',
      '/logs/security.log',
      '--type',
      'asterisk',
    ).stdout;
    const parsed = explain.match(/🟢 crowdsecurity\/asterisk-logs/g)?.length ?? 0;
    assert.ok(parsed >= 1, `CrowdSec parsed nothing:\n${explain}`);
    console.log(`crowdsec: crowdsecurity/asterisk-logs parsed ${parsed} lines`);
  } finally {
    docker('rm', '-f', cs);
  }
} finally {
  phones.stop();
}

// 2. Screenshots for the guide.
const p = await launch({ width: 1280, height: 900, shotsDir: imgDir });
try {
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname.startsWith('/admin')`, 'signed in');

  await p.goto(`${base}/admin/trunks`);
  await p.waitFor(`document.body?.innerText.includes('New trunk')`, 'trunks page');
  await p.click('New trunk');
  await p.waitFor(`!!document.querySelector('dialog[open] details')`, 'trunk form');
  await p.evaluate(`document.querySelector('dialog[open] details').open = true`);
  await p.fill('Server', 'chicago1.voip.ms');
  await p.shot('voipms-trunk-form');

  // Numbers need a trunk (it won't register: the screenshot is of the form).
  const t = await fetch(`${base}/api/trunks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'selfphoneng', cookie },
    body: JSON.stringify({
      name: 'voip.ms',
      serverHost: 'chicago1.voip.ms',
      username: '123456_pbx',
      password: 'not-a-real-password-1',
    }),
  });
  assert.equal(t.status, 201, await t.text());
  await p.goto(`${base}/admin/numbers`);
  await p.waitFor(`document.body?.innerText.includes('Add number')`, 'numbers page');
  await p.click('Add number');
  await p.waitFor(`!!document.querySelector('dialog[open]')`, 'number form');
  await p.shot('add-number');

  for (const tab of ['network', 'emergency', 'recording', 'backups']) {
    await p.goto(`${base}/admin/settings/${tab}`);
    await p.waitFor(
      `!!document.querySelector('main form, main section') && !!document.querySelector('main h1')`,
      tab,
    );
    await sleep(500);
    await p.shot(`settings-${tab}`);
  }
  console.log(`screenshots: 6 in ${imgDir}`);
  // 3. Links and images in the guide.
  let links = 0;
  for (const f of readdirSync(GUIDE).filter((f) => f.endsWith('.md'))) {
    const md = readFileSync(join(GUIDE, f), 'utf8');
    for (const [, target, anchor] of md.matchAll(
      /\]\((?!https?:|mailto:)([^)#\s]*)(?:#([^)\s]+))?\)/g,
    )) {
      const file = resolve(GUIDE, target || f);
      assert.ok(existsSync(file), `${f}: broken link ${target}`);
      // GitHub's heading ids: lower case, punctuation dropped, spaces to dashes.
      if (anchor)
        assert.ok(
          [...readFileSync(file, 'utf8').matchAll(/^#+ (.+)$/gm)].some(
            ([, h]) =>
              h
                .toLowerCase()
                .replace(/[^\w\- ]/g, '')
                .replace(/ /g, '-') === anchor,
          ),
          `${f}: no heading for #${anchor} in ${target || f}`,
        );
      links++;
    }
  }
  console.log(`guide: ${links} relative links and images, none broken`);
  console.log('M11-T7: PASS');
} finally {
  await p.close();
}
