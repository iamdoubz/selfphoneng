// SPDX-License-Identifier: AGPL-3.0-or-later
// POST /v1/check {host, tests}: runs the tests against the address the request came from and
// answers {ip, results}. GET /healthz. No other target can be given, which is what keeps the probe
// from being aimed at someone else; each address gets a few checks per 10 minutes.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { isIP } from 'node:net';
import { runTest, type Result, type Test } from './checks.ts';

export type ProbeOptions = {
  /** Behind a reverse proxy: the address is the last X-Forwarded-For entry (the proxy adds it). */
  trustProxy?: boolean;
  /** Checks per address per window. */
  maxChecks?: number;
  windowMs?: number;
};

const HOST =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const KINDS = new Set(['tcp', 'http', 'https', 'sip-udp', 'sip-tcp', 'sip-tls', 'udp']);
const MAX_TESTS = 20;

/** The tests, or why they're not acceptable. */
export function parseCheck(body: unknown): { host: string; tests: Test[] } | string {
  const b = body as { host?: unknown; tests?: unknown };
  if (typeof b?.host !== 'string' || !(HOST.test(b.host) || isIP(b.host)))
    return 'host: a host name';
  if (!Array.isArray(b.tests) || !b.tests.length || b.tests.length > MAX_TESTS)
    return `tests: 1 to ${MAX_TESTS}`;
  const tests: Test[] = [];
  for (const t of b.tests as Record<string, unknown>[]) {
    if (typeof t?.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(t.id)) return 'tests[].id';
    if (typeof t.kind !== 'string' || !KINDS.has(t.kind)) return `${t.id}: kind`;
    if (!Number.isInteger(t.port) || (t.port as number) < 1 || (t.port as number) > 65535)
      return `${t.id}: port`;
    if (t.path !== undefined && (typeof t.path !== 'string' || !/^\/[\w./~-]{0,100}$/.test(t.path)))
      return `${t.id}: path`;
    if (t.kind === 'udp' && (typeof t.token !== 'string' || !/^[A-Za-z0-9]{8,64}$/.test(t.token)))
      return `${t.id}: token`;
    tests.push({
      id: t.id,
      kind: t.kind,
      port: t.port,
      ...(t.path !== undefined && { path: t.path }),
      ...(t.websocket === true && { websocket: true }),
      ...(t.kind === 'udp' && { token: t.token }),
    } as Test);
  }
  return { host: b.host, tests };
}

const clientIp = (req: IncomingMessage, trustProxy: boolean) => {
  const xff = req.headers['x-forwarded-for'];
  const raw =
    trustProxy && typeof xff === 'string'
      ? xff.split(',').at(-1)!.trim()
      : req.socket.remoteAddress!;
  return raw.replace(/^::ffff:/, '');
};

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 8192) req.destroy(new Error('too big'));
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

export function createProbe(opts: ProbeOptions = {}): Server {
  const { trustProxy = false, maxChecks = 10, windowMs = 10 * 60_000 } = opts;
  // ponytail: in-process memory; addresses past the window are swept on each check.
  const seen = new Map<string, number[]>();
  const allow = (ip: string, now = Date.now()) => {
    for (const [k, v] of seen) if (now - v.at(-1)! >= windowMs) seen.delete(k);
    const list = (seen.get(ip) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= maxChecks) return false;
    seen.set(ip, [...list, now]);
    return true;
  };
  const send = (res: import('node:http').ServerResponse, code: number, body: unknown) =>
    res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));

  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true });
    if (req.method !== 'POST' || req.url !== '/v1/check')
      return send(res, 404, { error: 'not found' });
    const ip = clientIp(req, trustProxy);
    void readJson(req)
      .then(async (body) => {
        const check = parseCheck(body);
        if (typeof check === 'string') return send(res, 400, { error: check });
        if (!allow(ip))
          return send(res, 429, { error: 'too many checks; try again in 10 minutes' });
        const results: Result[] = await Promise.all(
          check.tests.map((t) => runTest(ip, check.host, t)),
        );
        send(res, 200, { ip, results });
      })
      .catch(() => send(res, 400, { error: 'a JSON body' }));
  });
}
