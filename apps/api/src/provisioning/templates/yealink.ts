// SPDX-License-Identifier: AGPL-3.0-or-later
// Yealink T3x/T4x/T5x <mac>.cfg (07 §3.1). Key names from Yealink's docs, (verify per model).
import { oneLine, xml, type PhonebookEntry, type ProvisionContext } from '../context.ts';
import { dialNowRules, ruleText } from '../dialplan.ts';

const TRANSPORT = { udp: 0, tcp: 1, tls: 2 } as const;
/** Line key 1 is the line; BLF keys are 2…; keys past the last BLF up to here are cleared. */
const LAST_KEY = 33;
/** Dial-now rules past the ones in use, up to here, are cleared. */
const LAST_DIALNOW = 20;

export function yealink(c: ProvisionContext): string {
  const v = oneLine;
  const now = dialNowRules(c.dialRules).slice(0, LAST_DIALNOW);
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
    '## BLF keys (line key 1 is the line); keys the PBX no longer uses are cleared',
    ...c.blf.flatMap((b, i) => [
      `linekey.${i + 2}.type = 16`,
      `linekey.${i + 2}.line = 1`,
      `linekey.${i + 2}.value = ${b.number}`,
      `linekey.${i + 2}.label = ${v(b.label)}`,
      `linekey.${i + 2}.pickup_value = **${b.number}`,
    ]),
    ...Array.from(
      { length: LAST_KEY - c.blf.length - 1 },
      (_, i) => `linekey.${i + c.blf.length + 2}.type = 0`,
    ),
    '## dial at once when the number is complete (911, full outside numbers); others wait for Send',
    ...now.map((d, i) => `dialplan.dialnow.rule.${i + 1} = ${ruleText(d)}`),
    ...Array.from(
      { length: LAST_DIALNOW - now.length },
      (_, i) => `dialplan.dialnow.rule.${i + now.length + 1} =`,
    ),
    '## time',
    `local_time.time_zone = ${c.timezone.yealinkOffset}`,
    `local_time.time_zone_name = ${c.timezone.yealinkName}`,
    `local_time.ntp_server1 = ${c.ntpServer}`,
    '## phonebook',
    `remote_phonebook.data.1.url = ${c.phonebookUrl}`,
    'remote_phonebook.data.1.name = Company',
    '## keep provisioning',
    `static.auto_provision.server.url = ${c.provUrl}`,
    `static.auto_provision.server.username = ${c.provUser}`,
    `static.auto_provision.server.password = ${c.provPassword}`,
    'static.auto_provision.repeat.enable = 1',
    'static.auto_provision.repeat.minutes = 1440',
    '',
  ].join('\n');
}

/** Remote phonebook XML (07 §3.1). */
export function yealinkPhonebook(entries: PhonebookEntry[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<YealinkIPPhoneDirectory>',
    ...entries.map(
      (e) =>
        `  <DirectoryEntry><Name>${xml(e.name)}</Name>${e.numbers
          .map((n) => `<Telephone label="${xml(n.label)}">${xml(n.number)}</Telephone>`)
          .join('')}</DirectoryEntry>`,
    ),
    '</YealinkIPPhoneDirectory>',
    '',
  ].join('\n');
}

/** y0000000000<xx>.cfg, the model-wide file: nothing in it, but it must be valid. */
export const yealinkCommon = () => '#!version:1.0.0.1\n';
