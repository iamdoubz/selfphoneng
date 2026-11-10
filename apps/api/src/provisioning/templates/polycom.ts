// SPDX-License-Identifier: AGPL-3.0-or-later
// Polycom / Poly VVX (07 §3.3), experimental. The phone asks for <mac>.cfg, the master file, which
// names phone-<mac>.cfg with the account. Parameter names from the UC Software admin guide,
// (verify per model). No BLF keys and no phonebook yet.
import { xml, type ProvisionContext } from '../context.ts';

const TRANSPORT = { udp: 'UDPOnly', tcp: 'TCPOnly', tls: 'TLS' } as const;
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** <mac>.cfg. No firmware is served: the phone keeps the one it has when sip.ld is a 404. */
export const polycomMaster = (c: ProvisionContext) =>
  [
    HEAD,
    `<APPLICATION APP_FILE_PATH="sip.ld" CONFIG_FILES="phone-${c.mac}.cfg" MISC_FILES="" LOG_FILE_DIRECTORY="" OVERRIDES_DIRECTORY="" CONTACTS_DIRECTORY="" LICENSE_DIRECTORY="" />`,
    '',
  ].join('\n');

/** "-6" or "-3:30" (hours) → seconds, as tcpIpApp.sntp.gmtOffset wants. */
export function gmtOffsetSeconds(offset: string): number {
  const [h, m = '0'] = offset.replace('-', '').split(':');
  return (offset.startsWith('-') ? -1 : 1) * (Number(h) * 3600 + Number(m) * 60);
}

/** phone-<mac>.cfg: the account, the voicemail light and key, and the time. */
export function polycom(c: ProvisionContext): string {
  const el = (name: string, attrs: Record<string, string | number>) =>
    [
      `  <${name}`,
      ...Object.entries(attrs).map(([k, v]) => `    ${k}="${xml(String(v))}"`),
      '  />',
    ].join('\n');
  return [
    HEAD,
    '<polycomConfig xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="polycomConfig.xsd">',
    el('reg', {
      'reg.1.address': c.ext.number,
      'reg.1.auth.userId': c.ext.number,
      'reg.1.auth.password': c.ext.sipPassword,
      'reg.1.displayName': c.ext.name,
      'reg.1.label': c.ext.number,
      'reg.1.server.1.address': c.host,
      'reg.1.server.1.port': c.sipPort,
      'reg.1.server.1.transport': TRANSPORT[c.transport],
      'reg.1.server.1.expires': 300,
    }),
    el('msg', {
      'msg.mwi.1.subscribe': c.ext.number,
      'msg.mwi.1.callBackMode': 'contact',
      'msg.mwi.1.callBack': c.voicemailNumber,
    }),
    el('tcpIpApp', {
      'tcpIpApp.sntp.address': c.ntpServer,
      'tcpIpApp.sntp.gmtOffset': gmtOffsetSeconds(c.timezone.yealinkOffset),
    }),
    '</polycomConfig>',
    '',
  ].join('\n');
}
