// SPDX-License-Identifier: AGPL-3.0-or-later
// M9-T1 in a browser, against a fake voip.ms API on 127.0.0.1:18090 (start the api with
// VOIPMS_API_URL=http://127.0.0.1:18090/api/v1/rest.php). A trunk with API access gets its POP
// list from voip.ms, a wrong API password shows voip.ms's reason, and "Import numbers from
// voip.ms" adds the picked numbers, not routed yet. The API password never reaches the api log.
// Runs after m1-t4.mjs.
// Usage: node scripts/e2e/m9-t1.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir> [<apiLog>]
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { launch } from './cdp.mjs';

const [base, email, pw, shotsDir, apiLog] = process.argv.slice(2);
const API_PW = 'Vms-api-pw-7731';

// The fake rest.php.
const seen = [];
const fake = createServer((req, res) => {
  const q = new URL(req.url, 'http://x').searchParams;
  seen.push(q.get('method'));
  const ok = q.get('api_username') === 'owner@example.com' && q.get('api_password') === API_PW;
  const answers = {
    getServersInfo: {
      status: 'success',
      servers: [
        { server_name: 'Chicago 4', server_hostname: 'chicago4.voip.ms' },
        { server_name: 'Dallas 2', server_hostname: 'dallas2.voip.ms' },
      ],
    },
    getDIDsInfo: {
      status: 'success',
      dids: [
        { did: '3125550144', description: 'Front desk', sms_enabled: '1' },
        { did: '3125550145', description: 'Fax', sms_enabled: '0' },
      ],
    },
  };
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(ok ? answers[q.get('method')] : { status: 'invalid_credentials' }));
});
await new Promise((r) => fake.listen(18090, '127.0.0.1', r));

const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-requested-with': 'selfphoneng' },
  body: JSON.stringify({ email, password: pw }),
});
const cookie = login.headers
  .getSetCookie()
  .map((c) => c.split(';')[0])
  .join('; ');
const made = await (
  await fetch(`${base}/api/trunks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'selfphoneng', cookie },
    body: JSON.stringify({
      name: 'voip.ms import',
      enabled: false, // never register to the real voip.ms from a test
      serverHost: 'chicago1.voip.ms',
      username: '123456_m9import',
      password: 'sub-pw',
      voipmsApiUsername: 'owner@example.com',
      voipmsApiPassword: 'wrong-pw-1',
    }),
  })
).json();
assert.ok(made.id, `trunk: ${JSON.stringify(made)}`);

const p = await launch({ shotsDir });
const openApi = `(() => { const d = [...document.querySelectorAll('dialog[open] details')].find(d => d.innerText.includes('voip.ms API')); d.open = true; return true; })()`;
const datalist = `[...document.querySelectorAll('#voipms-servers option')].map(o => o.value).join()`;
try {
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`);

  // Wrong API password: the built-in server list and voip.ms's reason.
  await p.click('Trunks');
  await p.waitFor(`document.body.innerText.includes('123456_m9import@')`, 'trunk listed');
  await p.evaluate(`(() => {
    const li = [...document.querySelectorAll('li')].find(l => l.innerText.includes('123456_m9import@'));
    [...li.querySelectorAll('button')].find(b => b.textContent === 'Edit').click();
    return true;
  })()`);
  await p.waitFor(`!!document.querySelector('dialog[open]')`);
  await p.waitFor(
    `document.querySelector('dialog[open]').innerText.includes('rejected the API username or password')`,
    'server list error shown',
  );
  assert.match(await p.evaluate(datalist), /chicago1\.voip\.ms/);
  console.log('wrong API password: the form says voip.ms rejected it, built-in server list');

  // The right one: the account's servers.
  await p.evaluate(openApi);
  await p.fill('API password', API_PW, 'dialog[open]');
  await p.click('Save', 'dialog[open]');
  await p.waitFor(`${datalist} === 'chicago4.voip.ms,dallas2.voip.ms'`, 'servers from voip.ms');
  console.log('API password saved: the server list comes from voip.ms (chicago4, dallas2)');

  // Import one of the two numbers.
  await p.evaluate(openApi);
  await p.click('Import numbers from voip.ms', 'dialog[open]');
  await p.waitFor(
    `document.querySelector('dialog[open]').innerText.includes('Front desk')`,
    'numbers listed',
  );
  await p.evaluate(`(() => {
    const l = [...document.querySelectorAll('dialog[open] label')].find(l => l.textContent.includes('Front desk'));
    l.querySelector('input').click();
    return true;
  })()`);
  await p.click('Import 1 number', 'dialog[open]');
  await p.waitFor(
    `document.querySelector('dialog[open]').innerText.includes('Added 1.')`,
    'imported',
  );
  await p.waitFor(
    `document.querySelector('dialog[open]').innerText.includes('(added)')`,
    'marked added',
  );
  await p.evaluate(
    `document.querySelector('dialog[open] fieldset legend')?.scrollIntoView({ block: 'start' }) ?? true`,
  );
  await p.shot('m9-t1-01-import');
  console.log('imported (312) 555-0144 "Front desk"; the list marks it added');

  await p.goto(`${base}/admin/numbers`);
  await p.waitFor(`document.body.innerText.includes('(312) 555-0144')`, 'on Phone numbers');
  const text = await p.text();
  assert.match(text, /Front desk/);
  assert.doesNotMatch(text, /555-0145/);
  await p.shot('m9-t1-02-numbers');
  console.log('Phone numbers lists it with its label; the other number was not imported');

  assert.ok(seen.includes('getServersInfo') && seen.includes('getDIDsInfo'));
  if (apiLog) {
    const log = readFileSync(apiLog, 'utf8');
    assert.ok(!log.includes(API_PW) && !log.includes('wrong-pw-1'), 'API password in the log');
    console.log('the api log never contains the API password');
  }
  console.log('M9-T1 (voip.ms API, import): PASS');
} catch (e) {
  await p.shot('m9-t1-fail').catch(() => {});
  console.log(`FAIL: ${e.message}`);
  console.log(`browser errors: ${JSON.stringify(p.consoleErrors)}`);
  process.exitCode = 1;
} finally {
  await p.close();
  fake.close();
}
