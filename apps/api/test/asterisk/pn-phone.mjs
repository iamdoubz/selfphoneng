// SPDX-License-Identifier: AGPL-3.0-or-later
// A phone that registers like iOS Linphone: push params holding '&' in its Contact. Answers
// qualify OPTIONS, prints the Request-URI of each INVITE ("INVITE <uri>") and turns it down (486),
// so the real phone on the same extension takes the call. call-test.ts runs it.
// Usage: node pn-phone.mjs <asterisk host> <user> <password>
import { createHash, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';

const [astHost, user, pass] = process.argv.slice(2);
const md5 = (s) => createHash('md5').update(s).digest('hex');
const ast = (await lookup(astHost)).address;
const me = Object.values(networkInterfaces())
  .flat()
  .find((i) => i.family === 'IPv4' && !i.internal).address;
const PORT = 5080;
const uri = `sip:${astHost}`;
const callId = randomUUID();
const tag = randomUUID().slice(0, 8);
const contact =
  `<sip:${user}@${me}:${PORT};pn-prid=AAAA1111:voip&bbbb2222:remote;pn-provider=apns;` +
  `pn-param=ABCD1234.org.linphone.phone.voip&remote;x-test=keep-me>`;

const sock = createSocket('udp4');
const send = (msg) => sock.send(msg, 5060, ast);
const register = (cseq, auth) =>
  [
    `REGISTER ${uri} SIP/2.0`,
    `Via: SIP/2.0/UDP ${me}:${PORT};rport;branch=z9hG4bK${randomUUID().slice(0, 12)}`,
    'Max-Forwards: 70',
    `From: <sip:${user}@${astHost}>;tag=${tag}`,
    `To: <sip:${user}@${astHost}>`,
    `Call-ID: ${callId}`,
    `CSeq: ${cseq} REGISTER`,
    `Contact: ${contact}`,
    'Expires: 300',
    ...(auth ? [`Authorization: ${auth}`] : []),
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n');

/** A response to a request: its Via, From, Call-ID and CSeq, and a To tag. */
const reply = (req, status) => {
  const keep = req.split('\r\n').filter((l) => /^(Via|From|To|Call-ID|CSeq):/i.test(l));
  const lines = keep.map((l) => (/^To:/i.test(l) && !/;tag=/.test(l) ? `${l};tag=${tag}` : l));
  return [`SIP/2.0 ${status}`, ...lines, 'Content-Length: 0', '', ''].join('\r\n');
};

sock.on('message', (buf) => {
  const msg = buf.toString();
  const first = msg.split('\r\n')[0];
  const challenge = /WWW-Authenticate: Digest (.*)/i.exec(msg)?.[1];
  if (first.includes(' 401 ') && challenge) {
    const p = Object.fromEntries(
      [...challenge.matchAll(/(\w+)="?([^",]*)"?/g)].map((m) => [m[1], m[2]]),
    );
    const cnonce = randomUUID().slice(0, 8);
    const ha1 = md5(`${user}:${p.realm}:${pass}`);
    const ha2 = md5(`REGISTER:${uri}`);
    const response = md5(`${ha1}:${p.nonce}:00000001:${cnonce}:auth:${ha2}`);
    send(
      register(
        2,
        `Digest username="${user}", realm="${p.realm}", nonce="${p.nonce}", uri="${uri}", ` +
          `response="${response}", algorithm=MD5, qop=auth, nc=00000001, cnonce="${cnonce}"` +
          (p.opaque ? `, opaque="${p.opaque}"` : ''),
      ),
    );
  } else if (first.startsWith('SIP/2.0 ')) console.log(`REGISTER ${first}`);
  else if (first.startsWith('OPTIONS ')) send(reply(msg, '200 OK'));
  else if (first.startsWith('INVITE ')) {
    console.log(first.split(' ').slice(0, 2).join(' '));
    send(reply(msg, '486 Busy Here'));
  }
});
sock.bind(PORT, () => send(register(1)));
