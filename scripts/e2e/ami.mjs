// SPDX-License-Identifier: AGPL-3.0-or-later
// A raw AMI session for the e2e scripts (the m2-live Asterisk publishes AMI on 127.0.0.1:15038).
import { Socket } from 'node:net';

/** One AMI action on its own session; rejects on Response: Error. */
export function action(fields) {
  return new Promise((resolve, reject) => {
    const s = new Socket();
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (d) => {
      buf += d;
      if (/Response: Error/.test(buf)) reject(new Error(buf));
      if (/ActionID: a1[\s\S]*\r\n\r\n/.test(buf)) {
        s.end();
        resolve();
      }
    });
    s.on('error', reject);
    s.connect(15038, '127.0.0.1', () => {
      const lines = Object.entries({ ...fields, ActionID: 'a1' })
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
      s.write(
        `Action: Login\r\nUsername: selfphoneng\r\nSecret: m2-live-secret\r\nEvents: off\r\n\r\n${lines}\r\n\r\n`,
      );
    });
  });
}

/** One AMI Originate with a caller ID (the CLI can't set one). */
export const originate = (fields) => action({ ...fields, Action: 'Originate', Async: 'true' });
