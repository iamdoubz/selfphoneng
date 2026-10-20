// SPDX-License-Identifier: AGPL-3.0-or-later
// M11-T6: the Reports page on real calls. Three calls through Asterisk: one answered by phone
// 260, one that goes to 261's voicemail (missed) and one through queue 560 that agent 260
// answers. The summary counts them like call history does (today, this hour, one missed), the
// queue table shows 560 with 1 offered and 1 answered, and the page shows it all, also at phone
// width without the page scrolling sideways.
// Runs on m2-live with a voicemail dir, after m1-t4.mjs.
// Usage: node scripts/e2e/m11-t6.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { originate } from './ami.mjs';
import { launch } from './cdp.mjs';
import { startPhones } from './phones.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (cmd) =>
  spawnSync('docker', ['exec', AST, 'asterisk', '-rx', cmd], { encoding: 'utf8' }).stdout ?? '';
const [base, email, pw, shotsDir] = process.argv.slice(2);
const until = async (what, ms, fn) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    assert.ok(Date.now() < end, `timed out: ${what}`);
    await sleep(500);
  }
};

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
  const text = await r.text();
  assert.ok(r.ok, `${method} ${url}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
};

const ann = await api('POST', '/api/extensions', { number: '260', name: 'Ann Agent' });
await api('POST', '/api/extensions', { number: '261', name: 'Vic Voicemail' });
const pass = (await api('GET', `/api/extensions/${ann.id}/sip-credentials`)).password;
await api('POST', '/api/queues', {
  number: '560',
  name: 'Support',
  maxWaitSeconds: 30,
  members: [{ extensionId: ann.id, penalty: 0 }],
  timeoutDestination: { type: 'hangup' },
});
const phones = startPhones({
  name: 'sp-live-phones-m11t6',
  net: NET,
  ast: AST,
  phones: [{ ext: '260', password: pass, answer: 'auto' }],
});
const browsers = [];
try {
  await until('phone 260 registered', 180_000, () =>
    /260\/sip:.*Avail/.test(cli('pjsip show contacts')),
  );
  await until(
    'mailbox 261 and queue 560 in Asterisk',
    30_000,
    () => /261/.test(cli('voicemail show users')) && /560/.test(cli('queue show 560')),
  );

  // The three calls, one after another so 260 is free for the queue call.
  const before = (await api('GET', '/api/calls')).items.length;
  const call = (Channel, data, n) =>
    originate({ Channel, Application: 'Wait', Data: data, CallerID: `"Caller" <${n}>` });
  await call('Local/260@sp-from-ext', '4', '3125550101');
  await until(
    'call 1 in history',
    60_000,
    async () => (await api('GET', '/api/calls')).items.length === before + 1,
  );
  cli(
    'channel originate Local/261@sp-vm-direct application Playback silence/10&silence/5&tt-weasels',
  );
  await until(
    'call 2 in history',
    90_000,
    async () => (await api('GET', '/api/calls')).items.length === before + 2,
  );
  await call('Local/560@sp-from-ext', '6', '3125550103');
  await until(
    'call 3 in history',
    90_000,
    async () => (await api('GET', '/api/calls')).items.length === before + 3,
  );
  const history = (await api('GET', '/api/calls')).items;
  console.log(
    `calls: ${history
      .slice(0, 3)
      .map((c) => `${c.toNumber} ${c.status}`)
      .join(', ')}`,
  );

  // The API agrees with call history.
  const s = await api('GET', '/api/reports/summary');
  assert.equal(s.days.length, 30);
  const today = s.days.at(-1);
  assert.equal(today.date, s.to);
  const missed = history.filter((c) => ['missed', 'voicemail', 'abandoned'].includes(c.status));
  assert.equal(s.totals.calls, history.length);
  assert.equal(s.totals.missed, missed.length);
  assert.ok(missed.length >= 1, 'the voicemail call counts as missed');
  assert.equal(today.inbound + today.outbound + today.internal, history.length);
  assert.equal(today.missed, missed.length);
  assert.equal(
    s.hours.flat().reduce((a, b) => a + b),
    history.length,
  );
  const [qr] = (await api('GET', '/api/reports/queues')).items;
  assert.deepEqual(
    { number: qr.number, offered: qr.offered, answered: qr.answered, sla: qr.withinSlaPercent },
    { number: '560', offered: 1, answered: 1, sla: 100 },
  );
  console.log(
    `summary: ${s.totals.calls} calls, ${s.totals.missed} missed, avg talk ${s.totals.avgTalkSeconds} s; queue 560: 1 offered, 1 answered, 100% in time`,
  );

  // The page.
  for (const width of [1280, 390]) {
    const p = await launch({ width, height: 900, shotsDir });
    browsers.push(p);
    await p.goto(`${base}/login`);
    await p.waitFor(`!!document.querySelector('input[type=email]')`);
    await p.fill('Email', email);
    await p.fill('Password', pw);
    await p.click('Sign in');
    await p.waitFor(`location.pathname.startsWith('/admin')`, 'signed in');
    await p.goto(`${base}/admin/reports`);
    await p.waitFor(
      `!!document.querySelector('[aria-label="Queue report"]') && !!document.querySelector('[aria-label="Totals"]')`,
      'reports page',
    );
    const totals = await p.evaluate(`document.querySelector('[aria-label="Totals"]').innerText`);
    assert.match(totals, new RegExp(`Calls\\s+${s.totals.calls}\\b`));
    assert.match(totals, new RegExp(`Missed\\s+${s.totals.missed}\\b`));
    const bars = await p.evaluate(
      `[...document.querySelectorAll('figure [role=img]')].map((b) => b.getAttribute('aria-label'))`,
    );
    assert.equal(bars.length, 60, 'two charts of 30 days');
    assert.match(
      bars[29],
      new RegExp(`${today.inbound} in, ${today.outbound} out, ${today.internal} internal$`),
    );
    assert.match(bars[59], new RegExp(`${today.missed} missed$`));
    const busiest = await p.evaluate(
      `[...document.querySelectorAll('[aria-label="Busiest hours"] td')].reduce((s, td) => s + Number(td.textContent), 0)`,
    );
    assert.equal(busiest, history.length);
    const row = await p.evaluate(
      `document.querySelector('[aria-label="Queue report"] tbody tr').innerText`,
    );
    assert.match(row, /560\s+Support\s+1\s+1\s+0\s+0\s+\d+ s\s+100%/);
    const sideways = await p.evaluate(
      'document.documentElement.scrollWidth > document.documentElement.clientWidth',
    );
    assert.equal(sideways, false, `page scrolls sideways at ${width}px`);
    await p.shot(`m11-t6-reports-${width}`);
  }
  console.log(
    'page: totals, both charts, busiest hours and the queue row match; no sideways scroll at 390px',
  );
  console.log('M11-T6: PASS');
} finally {
  for (const b of browsers) await b.close();
  phones.stop();
}
