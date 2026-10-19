// SPDX-License-Identifier: AGPL-3.0-or-later
// Yealink T3x/T4x/T5x <mac>.cfg (07 §3.1). Key names from Yealink's docs, (verify per model).
import { oneLine, type ProvisionContext } from '../context.ts';

const TRANSPORT = { udp: 0, tcp: 1, tls: 2 } as const;

export function yealink(c: ProvisionContext): string {
  const v = oneLine;
  return [
    '#!version:1.0.0.1',
    '## account 1',
    'account.1.enable = 1',
    `account.1.label = ${v(`${c.ext.number} ${c.ext.name}`)}`,
    `account.1.display_name = ${v(c.ext.name)}`,
    `account.1.auth_name = ${c.ext.number}`,
    `account.1.user_name = ${c.ext.number}`,
    `account.1.password = ${c.ext.sipPassword}`,
    `account.1.sip_server.1.address = ${c.host}`,
    `account.1.sip_server.1.port = ${c.sipPort}`,
    `account.1.sip_server.1.transport_type = ${TRANSPORT[c.transport]}`,
    'account.1.sip_server.1.expires = 300',
    'account.1.dtmf.type = 1',
    'account.1.subscribe_mwi_to_vm = 1',
    `voice_mail.number.1 = ${c.voicemailNumber}`,
    'features.pickup.direct_pickup_enable = 1',
    'features.pickup.direct_pickup_code = **',
    'features.pickup.group_pickup_enable = 1',
    'features.pickup.group_pickup_code = *8',
    '## keep provisioning',
    `static.auto_provision.server.url = ${c.provUrl}`,
    `static.auto_provision.server.username = ${c.provUser}`,
    `static.auto_provision.server.password = ${c.provPassword}`,
    'static.auto_provision.repeat.enable = 1',
    'static.auto_provision.repeat.minutes = 1440',
    '',
  ].join('\n');
}

/** y0000000000<xx>.cfg, the model-wide file: nothing in it, but it must be valid. */
export const yealinkCommon = () => '#!version:1.0.0.1\n';
