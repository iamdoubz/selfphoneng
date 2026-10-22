// SPDX-License-Identifier: AGPL-3.0-or-later
// Spec 10 §3 on the Recordings page: a recording with a summary and a transcript (put straight
// into the database), Show transcript, and search by what was said. Runs after m1-t4.mjs. Usage:
//   PG_CONTAINER=selfphoneng-postgres-1 PG_DB=<db> node scripts/e2e/call-transcripts.mjs \
//     <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { launch } from './cdp.mjs';

const [base, email, pw, shotsDir] = process.argv.slice(2);
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
psql(`insert into recordings (linkedid, file_path, started_at, duration_ms, transcript, summary, ai_done_at) values
  ('e2e-t1', '2026/10/21/e2e-t1.wav', now() - interval '1 hour', 42000,
   '[{"side":"caller","at":0.4,"text":"Hi, I never got the invoice."},{"side":"other","at":2.9,"text":"I''ll email it today."}]',
   E'The caller never got their invoice; it will be emailed today.\\nAction items:\\n- Email the invoice today', now()),
  ('e2e-t2', '2026/10/21/e2e-t2.wav', now() - interval '2 hours', 30000, null, null, now())`);
psql(
  `update recordings set ai_error = 'Recorded before call transcripts were on' where linkedid = 'e2e-t2'`,
);

const text = (s) => `document.body.innerText.includes(${JSON.stringify(s)})`;
const p = await launch({ shotsDir });
try {
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`, 'signed in');

  await p.goto(`${base}/admin/recordings`);
  await p.waitFor(text('Action items:'), 'summary');
  await p.waitFor(text('No transcript: Recorded before call transcripts were on'), 'why not');
  await p.click('Show transcript');
  await p.waitFor(`!!document.querySelector('ol[aria-label="Transcript"]')`, 'transcript');
  const lines = await p.evaluate(
    `[...document.querySelectorAll('ol[aria-label="Transcript"] li')].map(l => l.innerText.replace(/\\s+/g, ' ')).join(' | ')`,
  );
  assert.equal(
    lines,
    "0:00 Caller Hi, I never got the invoice. | 0:02 Other side I'll email it today.",
  );
  await p.shot('ct-01-transcript');
  console.log('recordings: summary, why one has none, the transcript in order');

  await p.evaluate(`(() => {
    const el = document.querySelector('input[aria-label="Search transcripts"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'email it');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await p.click('Search');
  await p.waitFor(
    `document.querySelectorAll('ul[aria-label="Recordings"] > li').length === 1 && ${text('Action items:')}`,
    'one match',
  );
  await p.evaluate(`(() => {
    const el = document.querySelector('input[aria-label="Search transcripts"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'refund');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await p.click('Search');
  await p.waitFor(text('No call mentions that.'), 'no match');
  await p.shot('ct-02-search');
  console.log('recordings: search finds the call by what was said, and says when nothing does');
} finally {
  await p.close();
}
