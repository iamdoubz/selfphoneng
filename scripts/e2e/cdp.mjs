// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal headless-Edge driver over the Chrome DevTools Protocol (no dependencies).
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Any Chromium: set BROWSER, e.g. /usr/bin/chromium or the Edge/Chrome .exe on Windows.
const EDGE = process.env.BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `args`: extra browser flags, e.g. a fake microphone for MediaRecorder tests. */
export async function launch({ width = 1280, height = 800, shotsDir, args = [] }) {
  const profile = mkdtempSync(join(tmpdir(), 'sp-edge-'));
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    `--window-size=${width},${height}`,
    ...args,
    'about:blank',
  ]);
  let info;
  for (let i = 0; i < 50 && !info; i++) {
    await sleep(200);
    info = await fetch(`http://127.0.0.1:${port}/json/list`)
      .then((r) => r.json())
      .then((l) => l.find((t) => t.type === 'page'))
      .catch(() => undefined);
  }
  const opts = { width, height, shotsDir };
  const page = await attach(info.webSocketDebuggerUrl, opts);
  /** Another tab in the same browser (same profile: storage, Web Locks, BroadcastChannel). */
  page.newTab = async (url) => {
    const t = await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: 'PUT' }).then((r) =>
      r.json(),
    );
    return attach(t.webSocketDebuggerUrl, opts);
  };
  const closeTab = page.close;
  page.close = async () => {
    await closeTab();
    proc.kill();
  };
  return page;
}

async function attach(wsUrl, { width, height, shotsDir }) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 500,
  });

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value;
  };
  const waitFor = async (expr, what, timeout = 8000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await evaluate(expr).catch(() => false)) return;
      await sleep(100);
    }
    throw new Error(`timeout waiting for: ${what ?? expr}`);
  };
  return {
    evaluate,
    waitFor,
    consoleErrors,
    goto: (url) => send('Page.navigate', { url }),
    path: () => evaluate('location.pathname'),
    /** Sets an input/select found by its <label> text, the way a user typing would (React sees it). */
    fill: (label, value) =>
      evaluate(`(() => {
        const l = [...document.querySelectorAll('label')].find(l => l.textContent.trim().startsWith(${JSON.stringify(label)}) && l.htmlFor && document.getElementById(l.htmlFor)?.offsetParent !== null);
        if (!l) throw new Error('no visible field ' + ${JSON.stringify(label)});
        const el = document.getElementById(l.htmlFor);
        const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
        return true;
      })()`),
    /** Clicks the first visible button/link whose text or aria-label matches. */
    /** `within`: a CSS selector to search inside, when the same label appears elsewhere. */
    click: (text, within = 'body') =>
      evaluate(`(() => {
        const t = ${JSON.stringify(text)};
        const root = document.querySelector(${JSON.stringify(within)});
        if (!root) throw new Error('no ' + ${JSON.stringify(within)});
        const el = [...root.querySelectorAll('button, a')].reverse().find(e => (e.textContent.trim() === t || e.getAttribute('aria-label') === t) && e.getClientRects().length);
        if (!el) throw new Error('no visible button ' + t);
        el.click();
        return true;
      })()`),
    text: () => evaluate('document.body.innerText'),
    shot: async (name) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(shotsDir, `${name}.png`), Buffer.from(r.data, 'base64'));
    },
    close: async () => ws.close(),
  };
}
