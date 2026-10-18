// SPDX-License-Identifier: AGPL-3.0-or-later
// M6-T4 in a browser + real calls: office hours built in the UI (open → 195, closed → 196, override
// key 1); Force closed / Force open route calls and set AstDB; *311 from an admin's phone (197)
// forces open and the page follows; the US federal holidays import.
// Runs on the m2-live setup after m1-t4.mjs.
// Usage: node scripts/e2e/m6-t4.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { launch } from './cdp.mjs';
import { startPhones } from './phones.mjs';

const NET = 'sp-live';
const AST = 'sp-live-ast';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (cmd) =>
  spawnSync('docker', ['exec', AST, 'asterisk', '-rx', cmd], { encoding: 'utf8' }).stdout ?? '';
const astLog = () => spawnSync('docker', ['logs', AST], { encoding: 'utf8' }).stdout ?? '';
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
    headers: { 'content-type': 'application/json', 'x-requested-with': 'selfphoneng', cookie },
    body: body && JSON.stringify(body),
  });
  const json = await r.json();
  assert.ok(r.ok, `${method} ${url}: ${r.status} ${JSON.stringify(json)}`);
  return json;
};
const desk = async (number, name, userId) => {
  const e = await api('POST', '/api/extensions', { number, name, ...(userId ? { userId } : {}) });
  return (await api('GET', `/api/extensions/${e.id}/sip-credentials`)).password;
};
const admin = (await api('GET', '/api/users')).items.find((u) => u.email === email);
const phones = startPhones({
  name: 'sp-live-phones-m6t4',
  net: NET,
  ast: AST,
  phones: [
    { ext: '195', password: await desk('195', 'Olive Open'), answer: 'auto' },
    { ext: '196', password: await desk('196', 'Cliff Closed'), answer: 'auto', toneHz: 660 },
    // The admin's own desk phone: allowed to use the override codes.
    ...(admin.extension
      ? []
      : [{ ext: '197', password: await desk('197', 'Admin Desk', admin.id), answer: 'auto' }]),
  ],
});

const waitUntil = async (fn, what, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(200);
  }
  throw new Error(`timeout waiting for: ${what}`);
};
const pick = (label, text) =>
  p.evaluate(`(() => {
    const s = [...document.querySelectorAll('dialog[open] select')].find(s => s.getAttribute('aria-label') === ${JSON.stringify(label)} || s.labels?.[0]?.textContent === ${JSON.stringify(label)});
    if (!s) throw new Error('no select ' + ${JSON.stringify(label)});
    const o = [...s.options].find(o => o.textContent.includes(${JSON.stringify(text)}));
    if (!o) throw new Error('no option ' + ${JSON.stringify(text)});
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, o.value);
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
const hangupAll = async () => {
  cli('channel request hangup all');
  await waitUntil(() => !/(PJSIP|Local)\//.test(cli('core show channels concise')), 'calls ended');
  await sleep(500);
};
/** A caller dropped straight into the office hours context; returns who got rung. */
async function callHours(id) {
  const at = astLog().length;
  cli(`channel originate Local/s@sp-tc-${id} application Wait 20`);
  let who = null;
  await waitUntil(() => {
    who = /Called PJSIP\/(19[56])\//.exec(astLog().slice(at))?.[1] ?? null;
    return who;
  }, 'someone rings');
  await hangupAll();
  return who;
}
const chip = () => p.evaluate(`document.querySelector('article [role=status]')?.textContent`);

const p = await launch({ shotsDir });
try {
  await waitUntil(
    () =>
      ['195', '196', '197'].every((n) =>
        new RegExp(`${n}/sip:.*Avail`).test(cli('pjsip show contacts')),
      ),
    'phones registered',
    180_000,
  );
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`);
  await p.click('Office hours');
  await p.click('Add office hours');
  await p.waitFor(`!!document.querySelector('dialog[open]')`);
  await p.fill('Name', 'Business hours', 'dialog[open]');
  await p.waitFor(
    `[...document.querySelectorAll('dialog[open] label')].find(l => l.textContent === 'Time zone')?.control.value === 'America/Chicago'`,
    'company time zone filled in',
  );
  // Paint Saturday 10:00–11:00 on the grid (two half-hour cells, a drag).
  // One event per step, like a real drag across frames (React re-renders in between).
  const pointer = (i, type) =>
    p.evaluate(
      `document.querySelector('[data-cell="sat-${i}"]').dispatchEvent(new PointerEvent('${type}', { bubbles: true })), true`,
    );
  await pointer(20, 'pointerdown');
  await sleep(100);
  await pointer(21, 'pointerover'); // React builds onPointerEnter from pointerover
  await sleep(100);
  await pointer(21, 'pointerup');
  await p.waitFor(
    `document.querySelector('dialog[open]').innerText.includes('Sat 10:00–11:00')`,
    'grid → ranges',
  );
  await pick('When open: type', 'Ring a user');
  await pick('When open: user', 'Olive Open');
  await pick('When closed: type', 'Ring a user');
  await pick('When closed: user', 'Cliff Closed');
  await pick('Phone override key', '1 (');
  await p.shot('m6-t4-01-form');
  await p.click('Save', 'dialog[open]');
  await p.waitFor(
    `!document.querySelector('dialog[open]') && !!document.querySelector('article')`,
    'saved',
  );
  const tc = (await api('GET', '/api/time-conditions')).items[0];
  assert.deepEqual(tc.openRanges, [
    { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '08:00', end: '17:00' },
    { days: ['sat'], start: '10:00', end: '11:00' },
  ]);
  await waitUntil(() => cli(`dialplan show s@sp-tc-${tc.id}`).includes('GotoIfTime'), 'dialplan');
  console.log(`office hours saved: ${await chip()} (Mon–Fri 08–17, Sat 10–11)`);

  await p.click('Force closed');
  await p.waitFor(
    `document.querySelector('article [role=status]')?.textContent === 'Closed now (forced)'`,
  );
  assert.match(cli('database show SP'), new RegExp(`/SP/TCOVR/${tc.id}\\s*:\\s*closed`));
  assert.equal(await callHours(tc.id), '196', 'forced closed → the closed destination');
  console.log('Force closed: AstDB set, a call goes to 196');

  await p.click('Force open');
  await p.waitFor(
    `document.querySelector('article [role=status]')?.textContent === 'Open now (forced)'`,
  );
  assert.equal(await callHours(tc.id), '195', 'forced open → the open destination');
  console.log('Force open: a call goes to 195');

  await p.click('Automatic');
  await p.waitFor(
    `!document.querySelector('article [role=status]')?.textContent.includes('forced')`,
  );
  assert.doesNotMatch(cli('database show SP'), /TCOVR/);
  console.log(`Automatic: AstDB key gone, ${await chip()}`);

  // *321 from the admin's desk phone forces closed; the page follows after a refresh.
  cli('channel originate PJSIP/197 extension *321@sp-from-ext');
  await waitUntil(
    async () => (await api('GET', `/api/time-conditions/${tc.id}`)).overrideState === 'closed',
    '*321 reached the database',
  );
  await p.goto(`${base}/admin/hours`);
  await p.waitFor(
    `document.querySelector('article [role=status]')?.textContent === 'Closed now (forced)'`,
  );
  console.log('*321 from the admin phone: forced closed in Asterisk and in the page');
  await hangupAll();
  cli('channel originate PJSIP/197 extension *331@sp-from-ext');
  await waitUntil(
    async () => (await api('GET', `/api/time-conditions/${tc.id}`)).overrideState === null,
    '*331 back to automatic',
  );
  await hangupAll();

  // A non-admin phone is refused.
  const before = astLog().length;
  cli('channel originate PJSIP/195 extension *311@sp-from-ext');
  await waitUntil(() => /Playing 'ss-noservice/.test(astLog().slice(before)), 'non-admin refused');
  assert.equal((await api('GET', `/api/time-conditions/${tc.id}`)).overrideState, null);
  console.log('*311 from a non-admin phone: "no service", nothing changed');
  await hangupAll();

  await p.click('Holidays');
  await p.evaluate(
    `[...document.querySelectorAll('button')].find(b => b.textContent.startsWith('Add US federal holidays for 2026'))?.click() ?? (() => { const s = document.getElementById('us-year'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, '2026'); s.dispatchEvent(new Event('change', { bubbles: true })); })(), true`,
  );
  await p.waitFor(
    `[...document.querySelectorAll('button')].some(b => b.textContent === 'Add US federal holidays for 2026')`,
  );
  await p.click('Add US federal holidays for 2026');
  await p.waitFor(`document.body.innerText.includes('Added 11.')`, 'imported');
  await p.waitFor(`document.body.innerText.includes('Thanksgiving Day')`);
  await p.shot('m6-t4-02-holidays');
  await waitUntil(
    () => /26,nov/.test(cli(`dialplan show s@sp-tc-${tc.id}`)),
    'holidays in the dialplan',
  );
  console.log('US federal holidays 2026 imported and in the dialplan');

  console.log('M6-T4 (office hours): PASS');
} catch (e) {
  await p.shot('m6-t4-fail').catch(() => {});
  console.log(`FAIL: ${e.message}`);
  console.log(`browser errors: ${JSON.stringify(p.consoleErrors)}`);
  process.exitCode = 1;
} finally {
  await p.close();
  phones.stop();
}
