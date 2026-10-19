// SPDX-License-Identifier: AGPL-3.0-or-later
// The SIP TLS certificate (M11-T2): TLS_DIR/fullchain.pem + privkey.pem, the same files Asterisk's
// transport-tls reads. Asterisk drops the transport without a word when they're missing, so the
// api checks them before TLS is turned on and the dashboard warns before they expire.
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TlsCert } from '@selfphoneng/shared';

export async function readTlsCert(dir: string): Promise<TlsCert> {
  let pem: string, key: string;
  try {
    [pem, key] = await Promise.all([
      readFile(join(dir, 'fullchain.pem'), 'utf8'),
      readFile(join(dir, 'privkey.pem'), 'utf8'),
    ]);
  } catch {
    return { ok: false, error: 'No certificate: put fullchain.pem and privkey.pem in data/tls' };
  }
  try {
    const cert = new X509Certificate(pem); // the first one in the chain is ours
    if (!cert.checkPrivateKey(createPrivateKey(key)))
      return { ok: false, error: "privkey.pem doesn't belong to the certificate in fullchain.pem" };
    return {
      ok: true,
      subject: cert.subject.replace(/\n/g, ', '),
      names: (cert.subjectAltName ?? '').split(', ').filter(Boolean),
      notAfter: new Date(cert.validTo).toISOString(),
    };
  } catch (e) {
    return { ok: false, error: `Can't read the certificate: ${(e as Error).message}` };
  }
}
