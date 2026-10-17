// SPDX-License-Identifier: AGPL-3.0-or-later
// Everything render() needs, loaded in one go (03 §1). render() itself does no I/O.
import { eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client.ts';
import { dids, extensions, users } from '../db/schema.ts';
import { decrypt } from '../crypto/secrets.ts';
import { getAllSettings } from '../services/settings.ts';

export type SnapExtension = {
  id: string;
  number: string;
  name: string;
  sipPassword: string; // decrypted
  webrtcEnabled: boolean;
  maxContacts: number;
  ringSeconds: number;
  voicemailEnabled: boolean;
  outboundClass: 'internal' | 'local' | 'national' | 'international';
  outboundCallerId: string | null; // DID number
  emergencyCallerId: string | null; // DID number
  recordMode: 'never' | 'inbound' | 'outbound' | 'all';
  pickupGroup: string | null;
  language: string;
  mohClass: string;
  isAdmin: boolean; // the extension's user is an admin (time-condition override codes)
};

export type SnapDid = { id: string; number: string };

export type Snapshot = {
  /** "YYYY-MM-DD" in general.timezone; render() never reads the clock. */
  today: string;
  settings: Awaited<ReturnType<typeof getAllSettings>>;
  extensions: SnapExtension[];
  dids: SnapDid[]; // M3 adds routing fields
};

export function todayIn(timezone: string, now = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
}

export async function loadSnapshot(db: Db, now = new Date()): Promise<Snapshot> {
  const settings = await getAllSettings(db);
  const outDid = alias(dids, 'out_did');
  const e911Did = alias(dids, 'e911_did');
  const rows = await db
    .select({
      ext: extensions,
      role: users.role,
      outCid: outDid.number,
      e911Cid: e911Did.number,
    })
    .from(extensions)
    .leftJoin(users, eq(users.id, extensions.userId))
    .leftJoin(outDid, eq(outDid.id, extensions.outboundCallerIdDidId))
    .leftJoin(e911Did, eq(e911Did.id, extensions.emergencyCallerIdDidId));

  const didRows = await db.select({ id: dids.id, number: dids.number }).from(dids);
  return {
    today: todayIn(settings['general.timezone'], now),
    settings,
    dids: didRows,
    extensions: rows.map(({ ext, role, outCid, e911Cid }) => ({
      id: ext.id,
      number: ext.number,
      name: ext.name,
      sipPassword: decrypt(ext.sipPasswordEnc),
      webrtcEnabled: ext.webrtcEnabled,
      maxContacts: ext.maxContacts,
      ringSeconds: ext.ringSeconds,
      voicemailEnabled: ext.voicemailEnabled,
      outboundClass: ext.outboundClass,
      outboundCallerId: outCid,
      emergencyCallerId: e911Cid,
      recordMode: ext.recordMode,
      pickupGroup: ext.pickupGroup,
      language: ext.language,
      mohClass: ext.mohClass,
      isAdmin: role === 'admin',
    })),
  };
}

/** Numeric order for internal numbers ("99" < "100"), then text as a tiebreak. */
export const byNumber = (a: { number: string }, b: { number: string }) =>
  Number(a.number) - Number(b.number) || a.number.localeCompare(b.number);
