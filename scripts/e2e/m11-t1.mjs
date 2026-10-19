// SPDX-License-Identifier: AGPL-3.0-or-later
// M11-T1 with real Asterisk and a real browser:
// - The admin pages load under the Content-Security-Policy with no violations.
// - Phone ACL: with "only accept desk phones from the networks below" on and the phones' Docker
//   network not in the list, a phone can't register; back in the list, it can.
// - Voicemail PIN changed from the phone (*98 → options → change password): a weak one is refused
//   by sp-vm-pincheck, a good one is stored by the api and stays in the generated config.
// Needs the Asterisk image with sp-vm-pincheck. Runs on m2-live, after m1-t4.mjs.
// Usage: node scripts/e2e/m11-t1.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir> <confDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './cdp.mjs';
import { startPhones } from './phones.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (cmd) =>
  spawnSync('docker', ['exec', AST, 'asterisk', '-rx', cmd], { encoding: 'utf8' }).stdout ?? '';
const astLog = () =>
  // eslint-disable-next-line no-control-regex -- Asterisk colors its log
  spawnSync('docker', ['logs', AST], { encoding: 'utf8' }).stdout.replace(/\x1b\[[0-9;]*m/g, '');
const [base, email, pw, shotsDir, confDir] = process.argv.slice(2);

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
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      'x-requested-with': 'selfphoneng',
      cookie,
    },
    body: body && JSON.stringify(body),
  });
  const json = await r.json();
  assert.ok(r.ok, `${method} ${url}: ${r.status} ${JSON.stringify(json)}`);
  return json;
};
const waitUntil = async (fn, what, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(300);
  }
  throw new Error(`timeout waiting for: ${what}`);
};
const vmConf = () => readFileSync(join(confDir, 'voicemail_selfphoneng.conf'), 'utf8');
const registered = (n) => new RegExp(`${n}/sip:.*Avail`).test(cli('pjsip show contacts'));
const settings = await api('GET', '/api/settings');

let phones;
const p = await launch({ shotsDir });
try {
  // CSP: the admin pages work with no violations.
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`);
  for (const page of ['Users & Extensions', 'Sounds & music', 'Phones', 'Settings', 'Dashboard'])
    await p.click(page);
  await p.click('Settings');
  await p.click('Security');
  await p.waitFor(`document.body.innerText.includes('Only accept desk phones')`, 'Security tab');
  await p.shot('m11-t1-01-security');
  const csp = p.consoleErrors.filter((e) => /Content.Security.Policy/i.test(e));
  assert.deepEqual(csp, [], 'CSP violations');
  console.log('admin pages load under the CSP with no violations; Settings → Security shown');

  // Phone ACL.
  const exts = {};
  for (const [n, name] of [
    ['390', 'Acl Inside'],
    ['391', 'Pin Changer'],
  ]) {
    const e = await api('POST', '/api/extensions', { number: n, name, voicemailPin: '4826' });
    exts[n] = e;
  }
  await api('PATCH', '/api/settings', {
    'sip.restrictPhonesToLocalNets': true,
    'network.localNets': ['192.168.0.0/16'],
  });
  await waitUntil(() => /permit/.test(cli('pjsip show endpoint 390')), 'ACL loaded');
  const pass = (await api('GET', `/api/extensions/${exts['390'].id}/sip-credentials`)).password;
  let at = astLog().length;
  phones = startPhones({
    name: 'sp-live-phones-m11t1',
    net: NET,
    ast: AST,
    phones: [{ ext: '390', password: pass, answer: 'auto' }],
  });
  await waitUntil(
    () =>
      /390.*(failed ACL|ACL)/i.test(astLog().slice(at)) ||
      /Failed to authenticate/.test(astLog().slice(at)),
    'registration refused by the ACL',
    180_000,
  );
  assert.ok(!registered('390'), '390 must not register');
  console.log('ACL on, Docker network not listed: 390 is refused');
  at = astLog().length;
  await api('PATCH', '/api/settings', { 'network.localNets': ['172.16.0.0/12'] });
  await waitUntil(() => registered('390'), '390 registers once its network is allowed', 120_000);
  console.log('its network allowed: 390 registers');
  await api('PATCH', '/api/settings', {
    'sip.restrictPhonesToLocalNets': settings['sip.restrictPhonesToLocalNets'],
    'network.localNets': settings['network.localNets'],
  });

  // A PIN changed from the phone. *98 asks for the mailbox and PIN; 0 = mailbox options,
  // 5 = change password, then the new PIN twice. Each w waits half a second.
  const changePin = (pin) =>
    cli(
      `channel originate Local/*98@sp-from-ext application SendDTMF ${'w'.repeat(8)}391#${'w'.repeat(8)}4826#${'w'.repeat(14)}0${'w'.repeat(10)}5${'w'.repeat(8)}${pin}#${'w'.repeat(8)}${pin}#${'w'.repeat(20)}`,
    );
  at = astLog().length;
  changePin('1111');
  await waitUntil(
    () =>
      /Password doesn't match policies|invalid-password|vm-invalid-password/.test(
        astLog().slice(at),
      ),
    'weak PIN refused by sp-vm-pincheck',
    60_000,
  );
  assert.match(vmConf(), /^391 => 4826,/m);
  console.log('a weak PIN (1111) from the phone is refused; the config keeps 4826');
  cli('channel request hangup all');
  await sleep(2000);
  changePin('7391');
  await waitUntil(() => /^391 => 7391,/m.test(vmConf()), 'new PIN in the generated config', 60_000);
  console.log('7391 from the phone: stored by the api and in the generated config');
  // A later apply keeps it (the database has it now).
  await api('PATCH', `/api/extensions/${exts['391'].id}`, { name: 'Pin Changer 2' });
  await sleep(3000);
  assert.match(vmConf(), /^391 => 7391,/m);
  console.log('a later config change keeps the new PIN');
  console.log('M11-T1 (headers, phone ACL, PIN rules): PASS');
} catch (e) {
  await p.shot('m11-t1-fail').catch(() => {});
  console.log(`FAIL: ${e.message}`);
  console.log(`browser errors: ${JSON.stringify(p.consoleErrors)}`);
  process.exitCode = 1;
} finally {
  await api('PATCH', '/api/settings', {
    'sip.restrictPhonesToLocalNets': settings['sip.restrictPhonesToLocalNets'],
    'network.localNets': settings['network.localNets'],
  }).catch(() => {});
  cli('channel request hangup all');
  await p.close();
  phones?.stop();
}
