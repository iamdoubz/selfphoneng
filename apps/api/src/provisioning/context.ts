// SPDX-License-Identifier: AGPL-3.0-or-later
// What a vendor template gets (07 §1). Templates are pure functions of this; no I/O there.
import { asc, eq, inArray } from 'drizzle-orm';
import { phoneTimezone, type PhoneTimezone, type PhoneVendor } from '@selfphoneng/shared';
import type { Config } from '../config.ts';
import { decrypt } from '../crypto/secrets.ts';
import type { Db } from '../db/client.ts';
import { devices, extensions } from '../db/schema.ts';
import { readBooks } from '../contacts/book.ts';
import { getSetting } from '../services/settings.ts';
import { loadDialRules, type DialRule } from './dialplan.ts';

export type ProvisionContext = {
  mac: string;
  vendor: PhoneVendor;
  model: string | null;
  host: string; // PUBLIC_HOSTNAME
  sipPort: number;
  transport: 'udp';
  ext: { number: string; name: string; sipPassword: string };
  voicemailNumber: '*97';
  /** extensions.blf_numbers in order, labeled with the extension's name when there is one. */
  blf: { number: string; label: string }[];
  timezone: PhoneTimezone & { iana: string; supported: boolean };
  provUrl: string;
  provUser: string;
  provPassword: string;
  /** The phonebook with this phone's credentials in it (phones fetch it like the config). */
  phonebookUrl: string;
  ntpServer: string;
  /** What's dialable (dialplan.ts), so phones can send complete numbers at once. */
  dialRules: DialRule[];
};

export const NTP_SERVER = 'pool.ntp.org';

export const provisioningUrl = (config: Pick<Config, 'PUBLIC_HOSTNAME'>) =>
  `https://${config.PUBLIC_HOSTNAME}/prov/`;

/** The device with this MAC and its extension, or null. */
export async function loadContext(
  db: Db,
  config: Pick<Config, 'PUBLIC_HOSTNAME'>,
  mac: string,
): Promise<{ id: string; ctx: ProvisionContext } | null> {
  const [row] = await db
    .select({ d: devices, e: extensions })
    .from(devices)
    .innerJoin(extensions, eq(extensions.id, devices.extensionId))
    .where(eq(devices.mac, mac));
  if (!row) return null;
  const { d, e } = row;
  const names = new Map(
    e.blfNumbers.length
      ? (
          await db
            .select({ number: extensions.number, name: extensions.name })
            .from(extensions)
            .where(inArray(extensions.number, e.blfNumbers))
        ).map((x) => [x.number, x.name])
      : [],
  );
  const iana = await getSetting(db, 'general.timezone');
  const provPassword = decrypt(d.provisioningPasswordEnc);
  return {
    id: d.id,
    ctx: {
      mac: d.mac,
      vendor: d.vendor as PhoneVendor,
      model: d.model,
      host: config.PUBLIC_HOSTNAME,
      // ponytail: desk phones register over UDP (they sit on the LAN); TLS when someone needs it.
      sipPort: await getSetting(db, 'sip.udpPort'),
      transport: 'udp',
      ext: { number: e.number, name: e.name, sipPassword: decrypt(e.sipPasswordEnc) },
      voicemailNumber: '*97',
      blf: e.blfNumbers.map((n) => ({ number: n, label: names.get(n) ?? n })),
      timezone: { ...phoneTimezone(iana), iana },
      provUrl: provisioningUrl(config),
      provUser: d.mac,
      provPassword,
      phonebookUrl: `https://${d.mac}:${provPassword}@${config.PUBLIC_HOSTNAME}/prov/phonebook/${d.mac}.xml`,
      ntpServer: NTP_SERVER,
      dialRules: await loadDialRules(db),
    },
  };
}

export type PhonebookEntry = { name: string; numbers: { label: string; number: string }[] };

/** The company phonebook (07 §2): every extension, then the company contacts, by name (from
 * Contrack's company account in Contrack mode, 11 §4.3). */
export async function loadPhonebook(db: Db): Promise<PhonebookEntry[]> {
  const exts = await db
    .select({ name: extensions.name, number: extensions.number })
    .from(extensions)
    .orderBy(asc(extensions.name));
  const company = (await readBooks(db, null)).items;
  return [
    ...exts.map((x) => ({ name: x.name, numbers: [{ label: 'Extension', number: x.number }] })),
    ...company.map((c) => ({
      name: c.name,
      numbers: (c.numbers as { label?: string; number?: string }[])
        .filter((n) => typeof n.number === 'string' && /^[0-9*#+]+$/.test(n.number))
        .map((n) => ({ label: n.label ?? '', number: n.number! })),
    })),
  ].filter((x) => x.numbers.length);
}

/** One line of text for a config value: no line breaks or control characters. */
// eslint-disable-next-line no-control-regex -- removing control characters is the point
export const oneLine = (v: string) => v.replace(/[\u0000-\u001f\u007f]/g, ' ');

export const xml = (v: string) =>
  oneLine(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
