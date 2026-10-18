// SPDX-License-Identifier: AGPL-3.0-or-later
// Everything render() needs, loaded in one go (03 §1). render() itself does no I/O.
import { eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client.ts';
import { dids, extensions, outboundRoutes, trunks, users } from '../db/schema.ts';
import { decrypt } from '../crypto/secrets.ts';
import { getAllSettings } from '../services/settings.ts';
import type { Destination, OutboundClass, RoutePattern } from '@selfphoneng/shared';

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

export type SnapDid = {
  id: string;
  number: string;
  trunkId: string;
  label: string | null;
  destination: Destination;
  callerIdNamePrefix: string | null;
};

export type SnapRoute = {
  id: string;
  name: string;
  position: number;
  enabled: boolean;
  patterns: RoutePattern[];
  requiredClass: OutboundClass;
  trunkIds: string[];
  callerId: string | null; // the override DID's number
};

export type SnapTrunk = {
  id: string;
  name: string;
  enabled: boolean;
  serverHost: string;
  serverPort: number;
  transport: 'udp' | 'tcp' | 'tls';
  authMode: 'registration' | 'ip';
  username: string | null;
  password: string | null; // decrypted
  fromUser: string | null;
  fromDomain: string | null;
  codecs: string[];
  srtp: boolean;
  maxChannels: number | null;
};

export type Snapshot = {
  /** "YYYY-MM-DD" in general.timezone; render() never reads the clock. */
  today: string;
  settings: Awaited<ReturnType<typeof getAllSettings>>;
  extensions: SnapExtension[];
  dids: SnapDid[];
  trunks: SnapTrunk[];
  routes: SnapRoute[];
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

  const didRows = await db
    .select({
      id: dids.id,
      number: dids.number,
      trunkId: dids.trunkId,
      label: dids.label,
      destination: dids.destination,
      callerIdNamePrefix: dids.callerIdNamePrefix,
    })
    .from(dids);
  const trunkRows = await db.select().from(trunks);
  const routeRows = await db.select().from(outboundRoutes);
  const didNumber = new Map(didRows.map((d) => [d.id, d.number]));
  return {
    today: todayIn(settings['general.timezone'], now),
    settings,
    dids: didRows.map((d) => ({ ...d, destination: d.destination as Destination })),
    routes: routeRows.map((r) => ({
      id: r.id,
      name: r.name,
      position: r.position,
      enabled: r.enabled,
      patterns: r.patterns as RoutePattern[],
      requiredClass: r.requiredClass,
      trunkIds: r.trunkIds,
      callerId: r.callerIdDidId ? (didNumber.get(r.callerIdDidId) ?? null) : null,
    })),
    trunks: trunkRows.map((t) => ({
      id: t.id,
      name: t.name,
      enabled: t.enabled,
      serverHost: t.serverHost,
      serverPort: t.serverPort,
      transport: t.transport,
      authMode: t.authMode,
      username: t.username,
      password: t.passwordEnc ? decrypt(t.passwordEnc) : null,
      fromUser: t.fromUser,
      fromDomain: t.fromDomain,
      codecs: t.codecs,
      srtp: t.srtp,
      maxChannels: t.maxChannels,
    })),
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
