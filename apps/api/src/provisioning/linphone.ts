// SPDX-License-Identifier: AGPL-3.0-or-later
// Linphone remote provisioning (07 §5): a QR of https://<host>/prov/linphone/<token>.xml. The token
// is stateless: base64url(extensionId.expiry.hmac), valid 24 h, HMAC-SHA256 with APP_SECRET.
// Regenerating the SIP password makes older configs useless anyway.
import { createHmac, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { xml } from './context.ts';

const TTL_S = 24 * 3600;
const sign = (secret: string, id: string, exp: number) =>
  createHmac('sha256', Buffer.from(secret, 'base64')).update(`${id}.${exp}`).digest('hex');

export function linphoneToken(secret: string, extensionId: string, now = Date.now()) {
  const exp = Math.floor(now / 1000) + TTL_S;
  return {
    token: Buffer.from(`${extensionId}.${exp}.${sign(secret, extensionId, exp)}`).toString(
      'base64url',
    ),
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/** The extension id in a valid, unexpired token, or null. */
export function verifyLinphoneToken(secret: string, token: string, now = Date.now()) {
  const parts = Buffer.from(token, 'base64url').toString('utf8').split('.');
  if (parts.length !== 3) return null;
  const [id, expS, mac] = parts as [string, string, string];
  const exp = Number(expS);
  if (!/^[0-9a-f-]{36}$/.test(id) || !Number.isInteger(exp) || exp * 1000 < now) return null;
  const want = Buffer.from(sign(secret, id, exp));
  const got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got) ? id : null;
}

export type LinphoneAccount = {
  host: string;
  sipPort: number;
  transport: 'udp' | 'tcp' | 'tls';
  number: string;
  name: string;
  sipPassword: string;
};

/** The remote provisioning XML. auth_info keys checked against liblinphone; proxy keys (verify). */
export function linphoneXml(a: LinphoneAccount): string {
  const name = xml(a.name).replace(/&quot;/g, "'");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<config xmlns="http://www.linphone.org/xsds/lpconfig.xsd">',
    '  <section name="proxy_0">',
    `    <entry name="reg_proxy">&lt;sip:${a.host}:${a.sipPort};transport=${a.transport}&gt;</entry>`,
    `    <entry name="reg_identity">"${name}" &lt;sip:${a.number}@${a.host}&gt;</entry>`,
    '    <entry name="reg_expires">600</entry>',
    '    <entry name="reg_sendregister">1</entry>',
    '  </section>',
    '  <section name="auth_info_0">',
    `    <entry name="username">${a.number}</entry>`,
    `    <entry name="passwd">${xml(a.sipPassword)}</entry>`,
    `    <entry name="domain">${a.host}</entry>`,
    '  </section>',
    '</config>',
    '',
  ].join('\n');
}

/** The link Linphone fetches and its QR (a PNG data URL); both stop working after 24 h. */
export async function softphoneQr(secret: string, host: string, extensionId: string) {
  const { token, expiresAt } = linphoneToken(secret, extensionId);
  const url = `https://${host}/prov/linphone/${token}.xml`;
  return { url, qr: await QRCode.toDataURL(url, { margin: 2, width: 280 }), expiresAt };
}
