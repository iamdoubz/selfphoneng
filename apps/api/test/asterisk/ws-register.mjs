// SPDX-License-Identifier: AGPL-3.0-or-later
// REGISTER over SIP WebSocket with digest auth, like the browser softphone through the reverse
// proxy. call-test.ts runs it in Asterisk's network namespace, so it comes from 127.0.0.1.
// Usage: node ws-register.mjs <ws url> <user> <password>. Prints the final status line.
import { createHash, randomUUID } from 'node:crypto';

const [url, user, pass] = process.argv.slice(2);
const md5 = (s) => createHash('md5').update(s).digest('hex');
const host = new URL(url).hostname;
const uri = `sip:${host}`;
const callId = randomUUID();
const tag = randomUUID().slice(0, 8);

const register = (cseq, auth) =>
  [
    `REGISTER ${uri} SIP/2.0`,
    `Via: SIP/2.0/WS ws-test.invalid;branch=z9hG4bK${randomUUID().slice(0, 12)}`,
    'Max-Forwards: 70',
    `From: <sip:${user}@${host}>;tag=${tag}`,
    `To: <sip:${user}@${host}>`,
    `Call-ID: ${callId}`,
    `CSeq: ${cseq} REGISTER`,
    `Contact: <sip:${user}@ws-test.invalid;transport=ws>`,
    'Expires: 60',
    ...(auth ? [`Authorization: ${auth}`] : []),
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n');

const ws = new WebSocket(url, 'sip');
const timer = setTimeout(() => {
  console.log('TIMEOUT');
  process.exit(1);
}, 10_000);
ws.onopen = () => ws.send(register(1));
ws.onerror = (e) => {
  console.log(`ERROR ${e.message ?? e}`);
  process.exit(1);
};
ws.onmessage = ({ data }) => {
  const msg = String(data);
  const status = msg.split('\r\n')[0];
  const challenge = /WWW-Authenticate: Digest (.*)/i.exec(msg)?.[1];
  if (status.includes(' 401 ') && challenge) {
    const p = Object.fromEntries(
      [...challenge.matchAll(/(\w+)="?([^",]*)"?/g)].map((m) => [m[1], m[2]]),
    );
    const cnonce = randomUUID().slice(0, 8);
    const ha1 = md5(`${user}:${p.realm}:${pass}`);
    const ha2 = md5(`REGISTER:${uri}`);
    const response = md5(`${ha1}:${p.nonce}:00000001:${cnonce}:auth:${ha2}`);
    ws.send(
      register(
        2,
        `Digest username="${user}", realm="${p.realm}", nonce="${p.nonce}", uri="${uri}", ` +
          `response="${response}", algorithm=MD5, qop=auth, nc=00000001, cnonce="${cnonce}"` +
          (p.opaque ? `, opaque="${p.opaque}"` : ''),
      ),
    );
    return;
  }
  console.log(status);
  clearTimeout(timer);
  ws.close();
};
