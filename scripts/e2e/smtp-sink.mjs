// SPDX-License-Identifier: AGPL-3.0-or-later
// Just enough SMTP for nodemailer: no auth, no TLS, keeps every message (raw RFC 5322 text).
import { createServer } from 'node:net';

export async function smtpSink(port = 2525) {
  const mails = [];
  const server = createServer((sock) => {
    let data = false;
    let buf = '';
    let msg = '';
    sock.write('220 sink ESMTP\r\n');
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (data) {
          if (line === '.') {
            data = false;
            mails.push(msg);
            msg = '';
            sock.write('250 ok\r\n');
          } else msg += line.replace(/^\.\./, '.') + '\n';
        } else if (/^EHLO/i.test(line)) sock.write('250-sink\r\n250 OK\r\n');
        else if (/^DATA/i.test(line)) {
          data = true;
          sock.write('354 go\r\n');
        } else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n');
        else sock.write('250 ok\r\n');
      }
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { mails, server };
}
