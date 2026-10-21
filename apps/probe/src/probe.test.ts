// SPDX-License-Identifier: AGPL-3.0-or-later
// The probe against stand-ins on 127.0.0.1: TCP, HTTP and a WebSocket upgrade, SIP over UDP and
// TCP, raw UDP; and the server: it only tests the address that asked, validates, rate-limits.
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createServer as httpServer, type Server as HttpServer } from 'node:http';
import { createServer as tcpServer, type AddressInfo, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runTest } from './checks.ts';
import { createProbe, parseCheck } from './server.ts';

const port = (s: Server | HttpServer) => (s.address() as AddressInfo).port;
const listen = <T extends Server | HttpServer>(s: T) =>
  new Promise<T>((r) => s.listen(0, '127.0.0.1', () => r(s)));
const bindUdp = (
  onMessage: (m: Buffer, from: { address: string; port: number }, s: UdpSocket) => void,
) =>
  new Promise<UdpSocket>((r) => {
    const s = createSocket('udp4');
    s.on('message', (m, from) => onMessage(m, from, s));
    s.bind(0, '127.0.0.1', () => r(s));
  });
const SIP_OK = (req: string) =>
  `SIP/2.0 401 Unauthorized\r\n${req
    .split('\r\n')
    .filter((l) => /^(Via|From|To|Call-ID|CSeq):/.test(l))
    .join('\r\n')}\r\nContent-Length: 0\r\n\r\n`;

describe('probe checks', () => {
  let http: HttpServer;
  let sipTcp: Server;
  let sipUdp: UdpSocket;
  let raw: UdpSocket;
  const got: string[] = [];
  beforeAll(async () => {
    http = await listen(httpServer((_req, res) => res.end('{"ok":true}')));
    http.on('upgrade', (req, sock) => {
      const ok = req.headers['sec-websocket-protocol'] === 'sip';
      sock.end(
        ok
          ? 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'
          : 'HTTP/1.1 400 Bad Request\r\n\r\n',
      );
    });
    sipTcp = await listen(tcpServer((s) => s.on('data', (d) => s.write(SIP_OK(d.toString())))));
    sipUdp = await bindUdp((m, from, s) => s.send(SIP_OK(m.toString()), from.port, from.address));
    raw = await bindUdp((m) => got.push(m.toString()));
  });
  afterAll(() => {
    http.close();
    sipTcp.close();
    sipUdp.close();
    raw.close();
  });

  it('TCP: connected, or refused', async () => {
    expect(
      await runTest('127.0.0.1', 'pbx.test', { id: 't', kind: 'tcp', port: port(http) }),
    ).toMatchObject({ ok: true, detail: 'connected' });
    const closed = await listen(tcpServer());
    const p = port(closed);
    closed.close();
    expect(await runTest('127.0.0.1', 'pbx.test', { id: 't', kind: 'tcp', port: p })).toMatchObject(
      { ok: false, detail: 'refused' },
    );
  });

  it('HTTP status, and a SIP WebSocket upgrade', async () => {
    expect(
      await runTest('127.0.0.1', 'pbx.test', {
        id: 'h',
        kind: 'http',
        port: port(http),
        path: '/healthz',
      }),
    ).toMatchObject({ ok: true, detail: 'HTTP 200' });
    expect(
      await runTest('127.0.0.1', 'pbx.test', {
        id: 'w',
        kind: 'http',
        port: port(http),
        path: '/ws',
        websocket: true,
      }),
    ).toMatchObject({ ok: true, detail: 'upgraded' });
  });

  it('SIP OPTIONS over UDP and TCP: any SIP answer', async () => {
    expect(
      await runTest('127.0.0.1', 'pbx.test', {
        id: 'u',
        kind: 'sip-udp',
        port: sipUdp.address().port,
      }),
    ).toMatchObject({ ok: true, detail: 'SIP/2.0 401 Unauthorized' });
    expect(
      await runTest('127.0.0.1', 'pbx.test', { id: 'c', kind: 'sip-tcp', port: port(sipTcp) }),
    ).toMatchObject({ ok: true, detail: 'SIP/2.0 401 Unauthorized' });
  });

  it('UDP: the token arrives', async () => {
    expect(
      await runTest('127.0.0.1', 'pbx.test', {
        id: 'r',
        kind: 'udp',
        port: raw.address().port,
        token: 'abcd1234ef',
      }),
    ).toMatchObject({ ok: true });
    expect(got).toContain('selfphoneng-probe abcd1234ef');
  });
});

describe('probe server', () => {
  it('validates: a host, 1–20 known tests, no target of its own', () => {
    expect(parseCheck({ host: 'pbx.test', tests: [{ id: 'a', kind: 'tcp', port: 443 }] })).toEqual({
      host: 'pbx.test',
      tests: [{ id: 'a', kind: 'tcp', port: 443 }],
    });
    // A target address in the body is simply not read.
    expect(
      parseCheck({
        host: 'pbx.test',
        ip: '192.0.2.1',
        tests: [{ id: 'a', kind: 'tcp', port: 1, ip: '192.0.2.1' }],
      }),
    ).toEqual({
      host: 'pbx.test',
      tests: [{ id: 'a', kind: 'tcp', port: 1 }],
    });
    for (const bad of [
      { tests: [{ id: 'a', kind: 'tcp', port: 1 }] },
      { host: 'a b', tests: [{ id: 'a', kind: 'tcp', port: 1 }] },
      { host: 'pbx.test', tests: [] },
      {
        host: 'pbx.test',
        tests: Array.from({ length: 21 }, (_, i) => ({ id: `a${i}`, kind: 'tcp', port: 1 })),
      },
      { host: 'pbx.test', tests: [{ id: 'a', kind: 'exec', port: 1 }] },
      { host: 'pbx.test', tests: [{ id: 'a', kind: 'tcp', port: 70000 }] },
      { host: 'pbx.test', tests: [{ id: 'a', kind: 'udp', port: 1, token: 'x' }] },
      { host: 'pbx.test', tests: [{ id: 'a', kind: 'http', port: 1, path: 'http://evil/' }] },
    ])
      expect(typeof parseCheck(bad)).toBe('string');
  });

  it('tests the address that asked (X-Forwarded-For only behind a proxy); limits checks', async () => {
    const target = await listen(tcpServer());
    const probe = await listen(createProbe({ maxChecks: 2 }));
    const ask = () =>
      fetch(`http://127.0.0.1:${port(probe)}/v1/check`, {
        method: 'POST',
        headers: { 'x-forwarded-for': '192.0.2.1' },
        body: JSON.stringify({
          host: 'pbx.test',
          tests: [{ id: 'tcp', kind: 'tcp', port: port(target) }],
        }),
      });
    const r = await ask();
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ip: '127.0.0.1', results: [{ id: 'tcp', ok: true }] });
    expect((await ask()).status).toBe(200);
    expect((await ask()).status).toBe(429);
    expect((await fetch(`http://127.0.0.1:${port(probe)}/healthz`)).status).toBe(200);
    probe.close();
    target.close();
  });
});
