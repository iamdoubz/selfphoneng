// SPDX-License-Identifier: AGPL-3.0-or-later
// M8-T5 with real calls: a music-on-hold set "sales-jazz" made on Sounds & music, a tone file
// uploaded into it. Asterisk lists the class with that file; a queue using it plays it to a
// waiting caller; a user using it gets moh_suggest (what the people they hold hear). An empty
// set falls back to the default music. Deleting the set is refused while the queue uses it.
// Runs on m2-live with a moh dir, after m1-t4.mjs.
// Usage: node scripts/e2e/m8-t5.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { launch } from './cdp.mjs';

const AST = 'sp-live-ast';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (cmd) =>
  spawnSync('docker', ['exec', AST, 'asterisk', '-rx', cmd], { encoding: 'utf8' }).stdout ?? '';
const astLog = () =>
  // eslint-disable-next-line no-control-regex -- Asterisk colors its log
  spawnSync('docker', ['logs', AST], { encoding: 'utf8' }).stdout.replace(/\x1b\[[0-9;]*m/g, '');
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
const api = async (method, url, body, ok = true) => {
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
  if (ok) assert.ok(r.ok, `${method} ${url}: ${r.status} ${JSON.stringify(json)}`);
  return { status: r.status, json };
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
/** A caller waiting in queue `q` (no agents) for 20 s. */
const caller = (q) => cli(`channel originate Local/${q}@sp-from-ext application Wait 20`);

const p = await launch({ shotsDir });
try {
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`);

  // The set and its music, in the UI.
  await p.click('Sounds & music');
  await p.waitFor(`document.body.innerText.includes('Music on hold')`);
  await p.fill('New set', 'Sales Jazz');
  await p.click('Add set');
  await p.waitFor(
    `document.body.innerText.includes('Lowercase letters, digits and dashes')`,
    'bad name refused',
  );
  await p.fill('New set', 'sales-jazz');
  await p.click('Add set');
  await p.waitFor(
    `!!document.querySelector('[aria-label="Music on hold sales-jazz"]')`,
    'set created',
  );
  // A 3 s 523 Hz tone picked in the set's file input.
  await p.evaluate(`(() => {
    const rate = 8000, n = rate * 3, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const s = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    s(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); s(8, 'WAVEfmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    s(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin((2 * Math.PI * 523 * i) / rate) * 8000, true);
    const dt = new DataTransfer();
    dt.items.add(new File([buf], 'smooth_jazz.wav', { type: 'audio/wav' }));
    const input = document.querySelector('[aria-label="Music on hold sales-jazz"] input[type=file]');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await p.click('Upload', '[aria-label="Music on hold sales-jazz"]');
  await p.waitFor(
    `!!document.querySelector('audio[aria-label="Play smooth jazz"]')`,
    'uploaded',
    15_000,
  );
  assert.match(await p.text(), /smooth jazz 0:03/);
  await p.shot('m8-t5-01-moh');
  console.log('set sales-jazz made in the UI (a bad name refused), "smooth jazz" 0:03 uploaded');

  // Asterisk has the class with that file.
  await waitUntil(
    () =>
      /Class: sales-jazz\n\tFile: \/var\/lib\/asterisk\/moh\/sales-jazz\//.test(
        cli('moh show files'),
      ),
    'moh show files lists the upload',
  );
  console.log('Asterisk: class sales-jazz plays the uploaded file');

  // A queue with it plays it to a waiting caller.
  const sets = (await api('GET', '/api/moh-classes')).json.items;
  const jazz = sets.find((c) => c.name === 'sales-jazz');
  const queue = (
    await api('POST', '/api/queues', {
      number: '560',
      name: 'Jazz line',
      mohClass: 'sales-jazz',
      joinWhenNoAgents: true,
      timeoutDestination: { type: 'hangup' },
    })
  ).json;
  await waitUntil(() => /musicclass|560 has/.test(cli('queue show 560')), 'queue 560 loaded');
  let at = astLog().length;
  caller('560');
  await waitUntil(
    () => /Started music on hold, class 'sales-jazz'/.test(astLog().slice(at)),
    'caller hears sales-jazz',
  );
  cli('channel request hangup all');
  console.log('queue 560: the waiting caller hears sales-jazz');

  // A user with it: what the people they put on hold hear.
  const ext = (await api('POST', '/api/extensions', { number: '330', name: 'Hal Hold' })).json;
  assert.equal(
    (await api('PATCH', `/api/extensions/${ext.id}`, { mohClass: 'nope' }, false)).status,
    400,
  );
  await api('PATCH', `/api/extensions/${ext.id}`, { mohClass: 'sales-jazz' });
  await waitUntil(
    () => /moh_suggest\s*:\s*sales-jazz/.test(cli('pjsip show endpoint 330')),
    'endpoint 330 suggests sales-jazz',
  );
  console.log('user 330: moh_suggest sales-jazz (an unknown set was refused)');

  // In use: can't delete. Emptied: the caller hears the default music.
  const del = await api('DELETE', `/api/moh-classes/${jazz.id}`, undefined, false);
  assert.equal(del.status, 409);
  assert.match(del.json.error.message, /extension 330.*queue Jazz line|queue Jazz line/);
  await api('DELETE', `/api/moh-classes/${jazz.id}/files/${jazz.files[0].id}`);
  await waitUntil(
    () =>
      !/Class: sales-jazz\n\tFile: \/var\/lib\/asterisk\/moh\/sales-jazz\//.test(
        cli('moh show files'),
      ),
    'emptied',
  );
  at = astLog().length;
  caller('560');
  await waitUntil(
    () => /Started music on hold, class 'default'/.test(astLog().slice(at)),
    'empty set: default music',
  );
  cli('channel request hangup all');
  console.log('delete refused while used; emptied set: the caller hears the default music');
  await api('DELETE', `/api/queues/${queue.id}`);
  console.log('M8-T5 (music on hold): PASS');
} catch (e) {
  await p.shot('m8-t5-fail').catch(() => {});
  console.log(`FAIL: ${e.message}`);
  console.log(`moh: ${cli('moh show classes')}`);
  console.log(`browser errors: ${JSON.stringify(p.consoleErrors)}`);
  process.exitCode = 1;
} finally {
  cli('channel request hangup all');
  await p.close();
}
