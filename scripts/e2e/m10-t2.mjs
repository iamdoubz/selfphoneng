// SPDX-License-Identifier: AGPL-3.0-or-later
// M10-T2 from the phone's side: a Yealink for 360 with BLF keys for 361 and 701 gets them named,
// the company time zone, and a phonebook URL; following that URL (credentials and all, as the
// phone does) returns the extensions and a company contact. Each BLF number has a hint in
// Asterisk to subscribe to. The Phones page warns when the time zone isn't one phones know.
// No real Yealink here: the hardware check stays open (09 M10).
// Runs on m2-live, after m1-t4.mjs.
// Usage: node scripts/e2e/m10-t2.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { launch } from './cdp.mjs';

const AST = 'sp-live-ast';
const cli = (cmd) =>
  spawnSync('docker', ['exec', AST, 'asterisk', '-rx', cmd], { encoding: 'utf8' }).stdout ?? '';
const [base, email, pw, shotsDir] = process.argv.slice(2);

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

const p = await launch({ shotsDir });
const settings = await api('GET', '/api/settings');
try {
  await api('POST', '/api/extensions', { number: '361', name: 'Bea Busy' });
  const ext = await api('POST', '/api/extensions', { number: '360', name: 'Ray Reception' });
  await api('PATCH', `/api/extensions/${ext.id}`, { blfNumbers: ['361', '701'] });
  const dev = await api('POST', '/api/devices', {
    mac: '00:15:65:36:00:00',
    vendor: 'yealink',
    extensionId: ext.id,
  });
  const auth = (user, pass) => ({
    authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`,
  });

  // The config, as the phone gets it.
  const cfg = await (
    await fetch(`${base}/prov/${dev.mac}.cfg`, { headers: auth(dev.mac, dev.provisioningPassword) })
  ).text();
  const val = (k) => new RegExp(`^${k.replace(/\./g, '\\.')} = (.*)$`, 'm').exec(cfg)?.[1];
  assert.equal(val('linekey.2.value'), '361');
  assert.equal(val('linekey.2.label'), 'Bea Busy');
  assert.equal(val('linekey.3.value'), '701');
  assert.equal(val('linekey.4.type'), '0');
  assert.equal(val('local_time.time_zone_name'), 'United States-Central Time');
  console.log('config: BLF 361 "Bea Busy" and 701, the rest cleared; Central time');

  // Each BLF number has a hint to subscribe to.
  const end = Date.now() + 30_000; // the new extensions reach Asterisk within seconds
  while (Date.now() < end && !/361@sp-local-numbers/.test(cli('core show hint 361')))
    await new Promise((r) => setTimeout(r, 300));
  assert.match(cli('core show hint 361'), /361@sp-local-numbers/);
  assert.match(cli('core show hint 701'), /701@sp-parkedcalls/);
  console.log('Asterisk has hints for 361 and the 701 parking slot');

  // The phonebook URL carries the phone's credentials; the phone fetches it as is.
  const pb = new URL(val('remote_phonebook.data.1.url'));
  assert.equal(pb.username, dev.mac);
  const book = await (
    await fetch(`${base}${pb.pathname}`, {
      headers: auth(decodeURIComponent(pb.username), decodeURIComponent(pb.password)),
    })
  ).text();
  assert.match(book, /<Name>Bea Busy<\/Name><Telephone label="Extension">361<\/Telephone>/);
  assert.match(book, /<Name>Ray Reception<\/Name>/);
  console.log('phonebook from the URL in the config: the extensions are in it');

  // A zone phones don't know: the Phones page says so.
  await api('PATCH', '/api/settings', { 'general.timezone': 'Asia/Tokyo' });
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`);
  await p.click('Phones');
  await p.waitFor(
    `document.body.innerText.includes("Desk phones don't know the time zone Asia/Tokyo")`,
    'time zone warning',
  );
  await p.shot('m10-t2-01-tz-warning');
  console.log('Asia/Tokyo: the Phones page warns that phones show UTC');
  console.log('M10-T2 (BLF, time zone, phonebook): PASS');
} catch (e) {
  await p.shot('m10-t2-fail').catch(() => {});
  console.log(`FAIL: ${e.message}`);
  console.log(`browser errors: ${JSON.stringify(p.consoleErrors)}`);
  process.exitCode = 1;
} finally {
  await api('PATCH', '/api/settings', { 'general.timezone': settings['general.timezone'] });
  await p.close();
}
