// SPDX-License-Identifier: AGPL-3.0-or-later
// The owner's 2026-10-21 features in a browser:
// - Settings → Numbering: the users range starts at 1, so Next free suggests 1.
// - Sounds & music: three files play in upload order; "Move … up" reorders them; Shuffle.
// - Reports: answered, talk time, outside minutes (in and out), and the voip.ms balance tile
//   (a trunk without API login says what to add).
// Calls for Reports go straight into the database (docker exec psql).
// Runs after m1-t4.mjs. Usage:
//   PG_CONTAINER=selfphoneng-postgres-1 PG_DB=<db> node scripts/e2e/numbers-music-reports.mjs \
//     <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { launch } from './cdp.mjs';

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
const api = async (method, url, body, type = 'application/json') => {
  const r = await fetch(`${base}${url}`, {
    method,
    headers: { cookie, 'x-requested-with': 'selfphoneng', ...(body && { 'content-type': type }) },
    body: body && type === 'application/json' ? JSON.stringify(body) : body,
  });
  const json = await r.json();
  assert.ok(r.ok, `${method} ${url}: ${JSON.stringify(json)}`);
  return json;
};
/** One second of a sine tone, 8 kHz mono 16-bit PCM. */
const tone = (hz) => {
  const n = 8000;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * hz * i) / 8000)), 44 + i * 2);
  return b;
};
const psql = (sql) => {
  const r = spawnSync(
    'docker',
    [
      'exec',
      process.env.PG_CONTAINER,
      'psql',
      '-U',
      'selfphoneng',
      '-d',
      process.env.PG_DB,
      '-c',
      sql,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
};
const text = (s) => `document.body.innerText.includes(${JSON.stringify(s)})`;
/** Types into an input found by its aria-label (the range grid has no <label>s). */
const fillAria = (p, label, value) =>
  p.evaluate(`(() => {
    const el = document.querySelector('input[aria-label=${JSON.stringify(label)}]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

// Setup: a music set with three files, a voip.ms trunk without API login, three calls today.
const cls = await api('POST', '/api/moh-classes', { name: 'lobby' });
for (const [name, hz] of [
  ['First', 440],
  ['Second', 550],
  ['Third', 660],
])
  await api('POST', `/api/moh-classes/${cls.id}/files?name=${name}`, tone(hz), 'audio/wav');
await api('POST', '/api/trunks', {
  name: 'voip.ms',
  serverHost: 'chicago1.voip.ms',
  username: '123456_pbx',
  password: 'pw',
});
psql(`insert into calls (linkedid, direction, status, started_at, ended_at, talk_seconds) values
  ('e2e-1', 'inbound', 'answered', now() - interval '2 hours', now() - interval '2 hours' + interval '300 seconds', 270),
  ('e2e-2', 'outbound', 'answered', now() - interval '1 hour', now() - interval '1 hour' + interval '130 seconds', 120),
  ('e2e-3', 'inbound', 'missed', now() - interval '30 minutes', now() - interval '30 minutes' + interval '20 seconds', 0)`);

const p = await launch({ shotsDir });
try {
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`, 'signed in');

  // Numbering
  await p.goto(`${base}/admin/settings/numbering`);
  await p.waitFor(text('Where Next free looks'), 'numbering tab');
  await fillAria(p, 'Users (extensions) from', '1');
  await p.click('Save');
  await p.waitFor(text('Saved.'), 'saved');
  await p.shot('o21-01-numbering');
  assert.equal((await api('GET', '/api/numbering/next?kind=user')).number, '1');
  console.log('numbering: users from 1, Next free suggests 1');

  // Music order and shuffle
  await p.goto(`${base}/admin/sounds`);
  const order = () =>
    p.evaluate(
      `[...document.querySelectorAll('ol[aria-label="Play order of lobby"] li')].map(l => l.innerText.match(/(First|Second|Third)/)[1]).join(' ')`,
    );
  await p.waitFor(`!!document.querySelector('ol[aria-label="Play order of lobby"]')`, 'play order');
  assert.equal(await order(), 'First Second Third');
  await p.click('Move Third up');
  await p.waitFor(
    `${JSON.stringify('First Third Second')} === [...document.querySelectorAll('ol[aria-label="Play order of lobby"] li')].map(l => l.innerText.match(/(First|Second|Third)/)[1]).join(' ')`,
    'moved',
  );
  const after = (await api('GET', '/api/moh-classes')).items.find((c) => c.name === 'lobby');
  assert.deepEqual(
    after.files.map((f) => f.name),
    ['First', 'Third', 'Second'],
  );
  await p.evaluate(
    `[...document.querySelectorAll('label')].find(l => l.textContent.trim().startsWith('Shuffle')).querySelector('input').click()`,
  );
  await p.waitFor(text('(plays in random order)'), 'shuffled');
  assert.equal(
    (await api('GET', '/api/moh-classes')).items.find((c) => c.name === 'lobby').shuffle,
    true,
  );
  assert.equal(
    await p.evaluate(`!!document.querySelector('[aria-label="Move First down"]')`),
    false,
  ); // order doesn't matter now
  await p.evaluate(
    `document.querySelector('ol[aria-label="Play order of lobby"]').scrollIntoView({ block: 'center' })`,
  );
  await p.shot('o21-02-music-order');
  console.log('music: reordered (First Third Second), shuffle on');

  // Reports
  await p.goto(`${base}/admin/reports`);
  await p.waitFor(`!!document.querySelector('dl[aria-label="Totals"]')`, 'totals');
  for (const s of [
    'Answered',
    'Talk time',
    'Outside minutes',
    'voip.ms balance',
    'API username and password',
    'Outside minutes per day',
  ])
    await p.waitFor(text(s), s);
  const tile = (k) =>
    p.evaluate(
      `[...document.querySelectorAll('dl[aria-label="Totals"] > div')].find(d => d.querySelector('dt').textContent === ${JSON.stringify(k)}).innerText`,
    );
  // 300 + 20 s in (from arrival), 120 s out (from the answer): 7 min; talk 270 + 120 s: 7 min
  assert.match(await tile('Outside minutes'), /7 min[\s\S]*5 min in, 2 min out/);
  assert.match(await tile('Talk time'), /7 min/);
  assert.match(await tile('Answered'), /2/);
  await p.shot('o21-03-reports');
  console.log('reports: answered, talk time, outside minutes in/out, balance tile');
} finally {
  await p.close();
}
