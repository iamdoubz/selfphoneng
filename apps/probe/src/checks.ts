// SPDX-License-Identifier: AGPL-3.0-or-later
// The network test probe's checks (08 §2.6). Each reaches a SelfPhoneNG server from outside its
// network, the way a phone on mobile data or the SIP provider would, and only ever at the address
// that asked (server.ts), so nobody can aim it at someone else.
import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { connect as tcpConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

export type Test =
  | { id: string; kind: 'tcp'; port: number }
  /** An HTTP(S) request; `websocket` asks for a SIP WebSocket upgrade (the browser phone's /ws). */
  | { id: string; kind: 'http' | 'https'; port: number; path?: string; websocket?: boolean }
  /** SIP OPTIONS: any SIP answer means Asterisk got it. */
  | { id: string; kind: 'sip-udp' | 'sip-tcp' | 'sip-tls'; port: number }
  /** Datagrams carrying `token`; the server listens and knows whether they came. */
  | { id: string; kind: 'udp'; port: number; token: string };

export type Result = { id: string; ok: boolean; detail: string; ms: number };

export const TIMEOUT_MS = 4000;
const rand = () => randomBytes(8).toString('hex');

/** Sends `request` over TCP or TLS and resolves with what came back once `done` matches it. */
function exchange(
  ip: string,
  port: number,
  opts: { tls: boolean; host: string; request: string; done: RegExp },
): Promise<{ data: string; certError: string | null }> {
  return new Promise((resolve, reject) => {
    let data = '';
    const onConnect = () => sock.write(opts.request);
    const sock: Socket = opts.tls
      ? tlsConnect(
          {
            host: ip,
            port,
            // The name to check the certificate against; SNI can't carry an IP.
            ...(isIP(opts.host) ? {} : { servername: opts.host }),
            rejectUnauthorized: false,
          },
          onConnect,
        )
      : tcpConnect({ host: ip, port }, onConnect);
    const finish = (err?: Error) => {
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else {
        const tls = sock as Socket & { authorized?: boolean; authorizationError?: Error };
        resolve({
          data,
          certError:
            opts.tls && !tls.authorized ? String(tls.authorizationError ?? 'not valid') : null,
        });
      }
    };
    const timer = setTimeout(() => finish(new Error('no answer')), TIMEOUT_MS);
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => {
      data += d;
      if (opts.done.test(data)) finish();
    });
    sock.on('error', (e) => finish(e));
    sock.on('close', () => (opts.done.test(data) ? finish() : finish(new Error('closed'))));
  });
}

const sipOptions = (transport: string, host: string, port: number) =>
  [
    `OPTIONS sip:${host}:${port};transport=${transport.toLowerCase()} SIP/2.0`,
    // rport: answer the address and port this came from (RFC 3581), not the made-up host.
    `Via: SIP/2.0/${transport} probe.invalid;branch=z9hG4bK${rand()};rport`,
    'Max-Forwards: 70',
    `From: <sip:probe@probe.invalid>;tag=${rand()}`,
    `To: <sip:${host}>`,
    `Call-ID: ${rand()}@probe.invalid`,
    'CSeq: 1 OPTIONS',
    'User-Agent: selfphoneng-probe',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n');

/** OPTIONS over UDP, sent three times (UDP drops); resolves with the first answer's status line. */
function sipUdp(ip: string, port: number, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = createSocket(isIP(ip) === 6 ? 'udp6' : 'udp4');
    const msg = Buffer.from(sipOptions('UDP', host, port));
    const timers = [0, 500, 1500].map((ms) =>
      setTimeout(() => sock.send(msg, port, ip, () => {}), ms),
    );
    const done = (fn: () => void) => {
      timers.forEach(clearTimeout);
      clearTimeout(timer);
      sock.close();
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error('no answer'))), TIMEOUT_MS);
    sock.on('message', (m) => {
      const line = m.toString('utf8').split('\r\n')[0]!;
      if (line.startsWith('SIP/2.0 ')) done(() => resolve(line));
    });
    sock.on('error', (e) => done(() => reject(e)));
  });
}

function sendUdp(ip: string, port: number, token: string): Promise<void> {
  return new Promise((resolve) => {
    const sock = createSocket(isIP(ip) === 6 ? 'udp6' : 'udp4');
    const msg = Buffer.from(`selfphoneng-probe ${token}`);
    let sent = 0;
    const one = () =>
      sock.send(msg, port, ip, () => {
        if (++sent === 3) {
          sock.close();
          resolve();
        }
      });
    one();
    setTimeout(one, 300);
    setTimeout(one, 600);
  });
}

const HTTP_STATUS = /^HTTP\/1\.[01] (\d{3})[^\r\n]*\r\n/;

export async function runTest(ip: string, host: string, t: Test): Promise<Result> {
  const start = Date.now();
  const result = (ok: boolean, detail: string): Result => ({
    id: t.id,
    ok,
    detail,
    ms: Date.now() - start,
  });
  try {
    switch (t.kind) {
      case 'tcp':
        await new Promise<void>((resolve, reject) => {
          const s = tcpConnect({ host: ip, port: t.port }, () => (s.destroy(), resolve()));
          s.setTimeout(TIMEOUT_MS, () => (s.destroy(), reject(new Error('no answer'))));
          s.on('error', reject);
        });
        return result(true, 'connected');
      case 'http':
      case 'https': {
        const upgrade = t.websocket
          ? [
              'Connection: Upgrade',
              'Upgrade: websocket',
              `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
              'Sec-WebSocket-Version: 13',
              'Sec-WebSocket-Protocol: sip',
            ]
          : ['Connection: close'];
        const request = [
          `GET ${t.path ?? '/'} HTTP/1.1`,
          `Host: ${host}`,
          'User-Agent: selfphoneng-probe',
          ...upgrade,
          '',
          '',
        ].join('\r\n');
        const r = await exchange(ip, t.port, {
          tls: t.kind === 'https',
          host,
          request,
          done: HTTP_STATUS,
        });
        const status = Number(HTTP_STATUS.exec(r.data)?.[1]);
        const cert = r.certError
          ? `; the certificate isn't valid for ${host} (${r.certError})`
          : '';
        if (t.websocket)
          return result(status === 101, `${status === 101 ? 'upgraded' : `HTTP ${status}`}${cert}`);
        return result(true, `HTTP ${status}${cert}`);
      }
      case 'sip-udp':
        return result(true, await sipUdp(ip, t.port, host));
      case 'sip-tcp':
      case 'sip-tls': {
        const tls = t.kind === 'sip-tls';
        const r = await exchange(ip, t.port, {
          tls,
          host,
          request: sipOptions(tls ? 'TLS' : 'TCP', host, t.port),
          done: /^SIP\/2\.0 \d{3}[^\r\n]*\r\n/,
        });
        return result(true, r.data.split('\r\n')[0]!);
      }
      case 'udp':
        await sendUdp(ip, t.port, t.token);
        return result(true, 'sent');
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return result(
      false,
      code === 'ECONNREFUSED' ? 'refused' : code ? code.toLowerCase() : (e as Error).message,
    );
  }
}
