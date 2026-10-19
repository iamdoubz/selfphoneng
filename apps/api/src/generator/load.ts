// SPDX-License-Identifier: AGPL-3.0-or-later
// Everything render() needs, loaded in one go (03 §1). render() itself does no I/O.
import { asc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client.ts';
import {
  announcements,
  conferences,
  dids,
  extensions,
  holidays,
  ivrOptions,
  pagingGroupMembers,
  pagingGroups,
  ivrs,
  outboundRoutes,
  queueMembers,
  queues,
  ringGroupMembers,
  ringGroups,
  soundFiles,
  timeConditions,
  trunks,
  users,
} from '../db/schema.ts';
import { decrypt } from '../crypto/secrets.ts';
import { getAllSettings } from '../services/settings.ts';
import type { Destination, OpenRange, OutboundClass, RoutePattern } from '@selfphoneng/shared';

export type SnapExtension = {
  id: string;
  number: string;
  name: string;
  sipPassword: string; // decrypted
  webrtcEnabled: boolean;
  maxContacts: number;
  ringSeconds: number;
  voicemailEnabled: boolean;
  voicemailPin: string; // decrypted
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
  recordInbound: boolean;
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

export type SnapRingGroup = {
  id: string;
  number: string;
  name: string;
  strategy: 'ringall' | 'hunt';
  ringSeconds: number;
  callerIdNamePrefix: string | null;
  musicInsteadOfRing: boolean;
  /** Extension numbers in ring order. */
  members: string[];
  noAnswerDestination: Destination;
};

export type SnapQueue = {
  id: string;
  number: string;
  name: string;
  strategy: 'ringall' | 'leastrecent' | 'fewestcalls' | 'random' | 'rrmemory' | 'linear';
  memberRingSeconds: number;
  retrySeconds: number;
  wrapupSeconds: number;
  maxWaitSeconds: number;
  maxCallers: number;
  mohClass: string;
  announcePosition: boolean;
  announceEverySeconds: number;
  joinWhenNoAgents: boolean;
  record: boolean;
  callerIdNamePrefix: string | null;
  members: { number: string; name: string; penalty: number }[];
  timeoutDestination: Destination;
};

export type SnapConference = {
  id: string;
  number: string;
  name: string;
  pin: string | null; // decrypted
  adminPin: string | null; // decrypted
  maxMembers: number;
  record: boolean;
};

export type SnapPagingGroup = {
  id: string;
  number: string;
  name: string;
  duplex: boolean;
  /** Extension numbers. */
  members: string[];
};

export type SnapIvr = {
  id: string;
  number: string;
  name: string;
  /** Asterisk sound names, e.g. custom/<id>. */
  greeting: string;
  invalidSound: string | null;
  timeoutSeconds: number;
  maxRetries: number;
  allowDirectDial: boolean;
  options: { digit: string; destination: Destination }[];
  timeoutDestination: Destination;
  invalidDestination: Destination;
};

export type SnapTimeCondition = {
  id: string;
  name: string;
  timezone: string;
  openRanges: OpenRange[];
  useHolidays: boolean;
  overrideDigit: number | null;
  openDestination: Destination;
  closedDestination: Destination;
  holidayDestination: Destination | null;
};

export type SnapHoliday = {
  name: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;
  recurringYearly: boolean;
};

export type SnapAnnouncement = {
  id: string;
  name: string;
  /** Asterisk sound name, e.g. custom/<id>. */
  sound: string;
  destination: Destination;
};

export type Snapshot = {
  /** "YYYY-MM-DD" in general.timezone; render() never reads the clock. */
  today: string;
  settings: Awaited<ReturnType<typeof getAllSettings>>;
  extensions: SnapExtension[];
  dids: SnapDid[];
  trunks: SnapTrunk[];
  routes: SnapRoute[];
  ringGroups: SnapRingGroup[];
  queues: SnapQueue[];
  conferences: SnapConference[];
  pagingGroups: SnapPagingGroup[];
  ivrs: SnapIvr[];
  timeConditions: SnapTimeCondition[];
  holidays: SnapHoliday[];
  announcements: SnapAnnouncement[];
  /** Played before recording a call that a phone number records (Settings → Recording). */
  recordingAnnouncement: string | null;
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
      recordInbound: dids.recordInbound,
    })
    .from(dids);
  const trunkRows = await db.select().from(trunks);
  const routeRows = await db.select().from(outboundRoutes);
  const groupRows = await db.select().from(ringGroups);
  const queueRows = await db.select().from(queues);
  const agentRows = await db
    .select({
      queueId: queueMembers.queueId,
      number: extensions.number,
      name: extensions.name,
      penalty: queueMembers.penalty,
    })
    .from(queueMembers)
    .innerJoin(extensions, eq(extensions.id, queueMembers.extensionId));
  const confRows = await db.select().from(conferences);
  const pageRows = await db.select().from(pagingGroups);
  const pagedRows = await db
    .select({ groupId: pagingGroupMembers.pagingGroupId, number: extensions.number })
    .from(pagingGroupMembers)
    .innerJoin(extensions, eq(extensions.id, pagingGroupMembers.extensionId));
  const ivrRows = await db.select().from(ivrs);
  const tcRows = await db.select().from(timeConditions);
  const holidayRows = await db.select().from(holidays);
  const annRows = await db.select().from(announcements);
  const optionRows = await db.select().from(ivrOptions);
  const soundName = new Map(
    (await db.select({ id: soundFiles.id, name: soundFiles.asteriskName }).from(soundFiles)).map(
      (s) => [s.id, s.name],
    ),
  );
  const memberRows = await db
    .select({ groupId: ringGroupMembers.ringGroupId, number: extensions.number })
    .from(ringGroupMembers)
    .innerJoin(extensions, eq(extensions.id, ringGroupMembers.extensionId))
    .orderBy(asc(ringGroupMembers.position));
  const didNumber = new Map(didRows.map((d) => [d.id, d.number]));
  return {
    today: todayIn(settings['general.timezone'], now),
    settings,
    dids: didRows.map((d) => ({ ...d, destination: d.destination as Destination })),
    timeConditions: tcRows.map((t) => ({
      id: t.id,
      name: t.name,
      timezone: t.timezone,
      openRanges: t.openRanges as OpenRange[],
      useHolidays: t.useHolidays,
      overrideDigit: t.overrideDigit,
      openDestination: t.openDestination as Destination,
      closedDestination: t.closedDestination as Destination,
      holidayDestination: t.holidayDestination as Destination | null,
    })),
    recordingAnnouncement: settings['recordings.announcementSoundId']
      ? (soundName.get(settings['recordings.announcementSoundId']) ?? null)
      : null,
    announcements: annRows.map((a) => ({
      id: a.id,
      name: a.name,
      sound: soundName.get(a.soundId)!,
      destination: a.destination as Destination,
    })),
    holidays: holidayRows.map((h) => ({
      name: h.name,
      startDate: h.startDate,
      endDate: h.endDate,
      recurringYearly: h.recurringYearly,
    })),
    ivrs: ivrRows.map((r) => ({
      id: r.id,
      number: r.number,
      name: r.name,
      greeting: soundName.get(r.greetingSoundId)!,
      invalidSound: r.invalidSoundId ? (soundName.get(r.invalidSoundId) ?? null) : null,
      timeoutSeconds: r.timeoutSeconds,
      maxRetries: r.maxRetries,
      allowDirectDial: r.allowDirectDial,
      options: optionRows
        .filter((o) => o.ivrId === r.id)
        .map((o) => ({ digit: o.digit, destination: o.destination as Destination })),
      timeoutDestination: r.timeoutDestination as Destination,
      invalidDestination: r.invalidDestination as Destination,
    })),
    ringGroups: groupRows.map((g) => ({
      id: g.id,
      number: g.number,
      name: g.name,
      strategy: g.strategy,
      ringSeconds: g.ringSeconds,
      callerIdNamePrefix: g.callerIdNamePrefix,
      musicInsteadOfRing: g.musicInsteadOfRing,
      members: memberRows.filter((m) => m.groupId === g.id).map((m) => m.number),
      noAnswerDestination: g.noAnswerDestination as Destination,
    })),
    queues: queueRows.map((q) => ({
      id: q.id,
      number: q.number,
      name: q.name,
      strategy: q.strategy,
      memberRingSeconds: q.memberRingSeconds,
      retrySeconds: q.retrySeconds,
      wrapupSeconds: q.wrapupSeconds,
      maxWaitSeconds: q.maxWaitSeconds,
      maxCallers: q.maxCallers,
      mohClass: q.mohClass,
      announcePosition: q.announcePosition,
      announceEverySeconds: q.announceEverySeconds,
      joinWhenNoAgents: q.joinWhenNoAgents,
      record: q.record,
      callerIdNamePrefix: q.callerIdNamePrefix,
      members: agentRows
        .filter((m) => m.queueId === q.id)
        .map(({ number, name, penalty }) => ({ number, name, penalty })),
      timeoutDestination: q.timeoutDestination as Destination,
    })),
    conferences: confRows.map((c) => ({
      id: c.id,
      number: c.number,
      name: c.name,
      pin: c.pinEnc ? decrypt(c.pinEnc) : null,
      adminPin: c.adminPinEnc ? decrypt(c.adminPinEnc) : null,
      maxMembers: c.maxMembers,
      record: c.record,
    })),
    pagingGroups: pageRows.map((g) => ({
      id: g.id,
      number: g.number,
      name: g.name,
      duplex: g.duplex,
      members: pagedRows.filter((m) => m.groupId === g.id).map((m) => m.number),
    })),
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
      voicemailPin: decrypt(ext.voicemailPinEnc),
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
