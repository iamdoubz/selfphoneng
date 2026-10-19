// SPDX-License-Identifier: AGPL-3.0-or-later
// Grandstream GRP/GXP cfg<mac>.xml (07 §3.2). P-values from Grandstream's docs, (verify per
// model). BLF/MPK keys differ by model family: left out of v1.
import { xml, type PhonebookEntry, type ProvisionContext } from '../context.ts';

const TRANSPORT = { udp: 0, tcp: 1, tls: 2 } as const;

export function grandstream(c: ProvisionContext): string {
  const p = (n: number, v: string | number, note: string) =>
    `    <P${n}>${xml(String(v))}</P${n}>${' '.repeat(Math.max(1, 34 - String(v).length))}<!-- ${note} -->`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gs_provision version="1">',
    `  <mac>${c.mac}</mac>`,
    '  <config version="1">',
    p(271, 1, 'account 1 active'),
    p(270, `${c.ext.number} ${c.ext.name}`, 'account name'),
    p(47, `${c.host}:${c.sipPort}`, 'SIP server'),
    p(35, c.ext.number, 'SIP user ID'),
    p(36, c.ext.number, 'auth ID'),
    p(34, c.ext.sipPassword, 'password'),
    p(3, c.ext.name, 'display name'),
    p(33, c.voicemailNumber, 'voicemail'),
    p(130, TRANSPORT[c.transport], 'SIP transport'),
    p(212, 2, 'config upgrade via HTTPS'),
    p(237, `${c.host}/prov`, 'config server path'),
    p(1360, c.provUser, 'HTTP(S) username'),
    p(1361, c.provPassword, 'HTTP(S) password'),
    p(30, c.ntpServer, 'NTP server'),
    p(64, c.timezone.posix, 'time zone (POSIX)'),
    p(330, 3, 'phonebook download: HTTPS'),
    // the phone appends /phonebook.xml to this path
    p(331, c.phonebookUrl.replace(/^https:\/\//, '').replace(/\.xml$/, ''), 'phonebook path'),
    p(332, 1440, 'phonebook refresh (minutes)'),
    '  </config>',
    '</gs_provision>',
    '',
  ].join('\n');
}

/** Phonebook XML (07 §2), (verify per model). */
export function grandstreamPhonebook(entries: PhonebookEntry[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<AddressBook>',
    ...entries.map(
      (e) =>
        `  <Contact><LastName>${xml(e.name)}</LastName>${e.numbers
          .map(
            (n) =>
              `<Phone><phonenumber>${xml(n.number)}</phonenumber><accountindex>1</accountindex></Phone>`,
          )
          .join('')}</Contact>`,
    ),
    '</AddressBook>',
    '',
  ].join('\n');
}
