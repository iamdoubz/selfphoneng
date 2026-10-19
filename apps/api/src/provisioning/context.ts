// SPDX-License-Identifier: AGPL-3.0-or-later
// What a vendor template gets (07 §1). Templates are pure functions of this; no I/O there.
// ponytail: M10-T1 has what a phone needs to register and stay provisioned; BLF keys, time zone
// and the phonebook (07 §3) arrive with M10-T2.
import { eq } from 'drizzle-orm';
import type { PhoneVendor } from '@selfphoneng/shared';
import type { Config } from '../config.ts';
import { decrypt } from '../crypto/secrets.ts';
import type { Db } from '../db/client.ts';
import { devices, extensions } from '../db/schema.ts';
import { getSetting } from '../services/settings.ts';

export type ProvisionContext = {
  mac: string;
  vendor: PhoneVendor;
  model: string | null;
  host: string; // PUBLIC_HOSTNAME
  sipPort: number;
  transport: 'udp';
  ext: { number: string; name: string; sipPassword: string };
  voicemailNumber: '*97';
  provUrl: string;
  provUser: string;
  provPassword: string;
};

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
      provUrl: provisioningUrl(config),
      provUser: d.mac,
      provPassword: decrypt(d.provisioningPasswordEnc),
    },
  };
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
