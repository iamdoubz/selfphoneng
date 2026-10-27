// SPDX-License-Identifier: AGPL-3.0-or-later
// CDR ingestion and call aggregation (04 §5.4). Every AMI Cdr event is stored raw in `cdr`; a few
// seconds after a call's last one, its rows (one linkedid) become one `calls` row plus who was
// involved. The rules are heuristics, pinned by fixtures recorded from real calls
// (test/fixtures/cdr, made by test/asterisk/cdr-record.ts).
import type { EventEmitter } from 'node:events';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, eq, inArray, isNull, lt } from 'drizzle-orm';
import { field, type AmiMessage } from '../ami/events.ts';
import type { Db } from '../db/client.ts';
import { checkNumber, usNumber, type SpamDeps } from '../spam/check.ts';
import { callExtensions, calls, cdr, dids, extensions, recordings } from '../db/schema.ts';
import { durationMs } from '../media/audio.ts';

type CdrRow = typeof cdr.$inferSelect;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** cdr_manager.conf has usegmtime = yes: "2026-10-18 19:28:37" is UTC. */
const utc = (v: string | undefined) => (v ? new Date(`${v.replace(' ', 'T')}Z`) : null);
const num = (v: string | undefined) => (v === undefined || v === '' ? null : Number(v));
const str = (v: string | undefined) => v || null;

export function toCdrRow(m: AmiMessage): typeof cdr.$inferInsert {
  const f = (k: string) => field(m, k);
  return {
    uniqueid: f('UniqueID') ?? '',
    linkedid: f('LinkedID') || f('UniqueID') || '',
    startAt: utc(f('StartTime')),
    answerAt: utc(f('AnswerTime')),
    endAt: utc(f('EndTime')),
    duration: num(f('Duration')),
    billsec: num(f('BillableSeconds')),
    src: str(f('Source')),
    dst: str(f('Destination')),
    dcontext: str(f('DestinationContext')),
    clid: str(f('CallerID')),
    channel: str(f('Channel')),
    dstchannel: str(f('DestinationChannel')),
    lastapp: str(f('LastApplication')),
    lastdata: str(f('LastData')),
    disposition: str(f('Disposition')),
    accountcode: str(f('AccountCode')),
    userfield: str(f('UserField')),
    spDid: str(f('sp_did')),
    spDirection: str(f('sp_direction')),
    spRecording: str(f('sp_recording')),
    raw: m,
  };
}

const isTrunk = (ch: string | null) => /^PJSIP\/trunk-/.test(ch ?? '');
/** "PJSIP/101-0000001" or "PJSIP/101-web-0000002" → "101"; Local channels don't count. */
export const extOf = (ch: string | null) =>
  /^PJSIP\/(\d+)(?:-web)?-[0-9a-f]+$/.exec(ch ?? '')?.[1] ?? null;
/** `"Mobile" <13125559999>` → Mobile. */
const nameOf = (clid: string | null) => /^"([^"]*)"/.exec(clid ?? '')?.[1] || null;

export type CallSummary = {
  direction: 'inbound' | 'outbound' | 'internal';
  status: 'answered' | 'missed' | 'voicemail' | 'abandoned' | 'busy' | 'failed';
  startedAt: Date;
  answeredAt: Date | null;
  endedAt: Date;
  fromNumber: string | null;
  fromName: string | null;
  toNumber: string | null;
  did: string | null;
  caller: string | null;
  rang: string[];
  answeredBy: string | null;
  talkSeconds: number;
  /** sp_recording: the MixMonitor file, relative to the recordings directory. */
  recording: string | null;
};

/** The pure part of aggregateCall: rows of one linkedid → what the call was. */
export function summarize(rows: CdrRow[]): CallSummary {
  const first = rows[0]!;
  const direction =
    (rows.find((r) => r.spDirection)?.spDirection as CallSummary['direction'] | undefined) ??
    (rows.some((r) => isTrunk(r.channel))
      ? 'inbound'
      : rows.some((r) => isTrunk(r.dstchannel))
        ? 'outbound'
        : 'internal');
  const did = rows.find((r) => r.spDid)?.spDid ?? null;
  const caller = extOf(first.channel);
  // Whose phones rang, plus whose mailbox took the call (DND, IVR → voicemail): it was for them.
  const mailbox = (r: CdrRow) =>
    r.lastapp === 'VoiceMail' ? (/^(\d+)@/.exec(r.lastdata ?? '')?.[1] ?? null) : null;
  const rang = [
    ...new Set(
      rows.flatMap((r) => [extOf(r.dstchannel), mailbox(r)]).filter((x): x is string => !!x),
    ),
  ];
  const answeredRow = rows.find((r) => r.disposition === 'ANSWERED' && extOf(r.dstchannel));
  const trunkAnswered = rows.find((r) => r.disposition === 'ANSWERED' && isTrunk(r.dstchannel));
  const answeredBy = answeredRow ? extOf(answeredRow.dstchannel) : null;
  const answered = answeredBy !== null || (direction === 'outbound' && !!trunkAnswered);
  const status: CallSummary['status'] = answered
    ? 'answered'
    : rows.some((r) => r.lastapp === 'VoiceMail' && (r.billsec ?? 0) > 0)
      ? 'voicemail'
      : rows.some((r) => r.lastapp === 'Queue')
        ? 'abandoned'
        : rows.some((r) => r.disposition === 'BUSY')
          ? 'busy'
          : rows.some((r) => r.disposition === 'FAILED' || r.disposition === 'CONGESTION')
            ? 'failed'
            : 'missed';
  const talkRows = rows.filter(
    (r) => r.disposition === 'ANSWERED' && (extOf(r.dstchannel) || isTrunk(r.dstchannel)),
  );
  const times = (k: 'startAt' | 'endAt') =>
    rows.map((r) => r[k]?.getTime()).filter((x): x is number => x !== undefined);
  return {
    direction,
    status,
    startedAt: new Date(Math.min(...times('startAt'))),
    answeredAt: (answeredRow ?? (answered ? trunkAnswered : undefined))?.answerAt ?? null,
    endedAt: new Date(Math.max(...times('endAt'), ...times('startAt'))),
    // A phone calling shows as its extension, not the caller ID it sends outside.
    fromNumber: caller ?? first.src,
    fromName: nameOf(first.clid),
    toNumber: direction === 'inbound' ? (did ?? first.dst) : first.dst,
    did,
    caller,
    rang,
    answeredBy,
    talkSeconds: Math.max(0, ...talkRows.map((r) => r.billsec ?? 0)),
    recording: rows.find((r) => r.spRecording)?.spRecording ?? null,
  };
}

/** Rebuilds the calls row for one linkedid (idempotent). */
/**
 * Links the call's recording if its file is there: size, length (ffprobe), one row per file.
 * The file path is relative and stays inside the recordings directory (it comes from AMI).
 */
async function linkRecording(db: Db | Tx, dir: string, s: CallSummary, linkedid: string) {
  if (!s.recording || !/^[\w./-]+\.wav$/.test(s.recording) || s.recording.includes('..'))
    return null;
  const file = join(dir, s.recording);
  const st = await stat(file).catch(() => null);
  if (!st?.isFile()) return null;
  const [r] = await db
    .insert(recordings)
    .values({
      linkedid,
      filePath: s.recording,
      startedAt: s.startedAt,
      sizeBytes: st.size,
      durationMs: await durationMs(file),
    })
    .onConflictDoUpdate({ target: recordings.filePath, set: { sizeBytes: st.size } })
    .returning({ id: recordings.id });
  return r!.id;
}

export async function aggregateCall(
  db: Db,
  linkedid: string,
  opts: { recordingsDir?: string; log?: SpamDeps['log'] } = {},
): Promise<void> {
  const rows = await db
    .select()
    .from(cdr)
    .where(eq(cdr.linkedid, linkedid))
    .orderBy(asc(cdr.startAt), asc(cdr.id));
  if (!rows.length) return;
  const s = summarize(rows);
  const numbers = [...new Set([s.caller, s.answeredBy, ...s.rang].filter((x): x is string => !!x))];
  const exts = numbers.length
    ? await db
        .select({ id: extensions.id, number: extensions.number })
        .from(extensions)
        .where(inArray(extensions.number, numbers))
    : [];
  const idOf = (n: string | null) => exts.find((e) => e.number === n)?.id ?? null;
  const [d] = s.did
    ? await db.select({ id: dids.id }).from(dids).where(eq(dids.number, s.did))
    : [];
  // 14 §6: what the spam check knows now (the cache, the local FTC copy), kept with the call.
  const spam =
    s.direction === 'inbound' && s.fromNumber
      ? await checkNumber({ db, log: opts.log ?? { warn() {} } }, usNumber(s.fromNumber), {
          cachedOnly: true,
        })
      : null;
  await db.transaction(async (tx) => {
    await tx.delete(calls).where(eq(calls.linkedid, linkedid));
    const [call] = await tx
      .insert(calls)
      .values({
        linkedid,
        direction: s.direction,
        status: s.status,
        startedAt: s.startedAt,
        answeredAt: s.answeredAt,
        endedAt: s.endedAt,
        fromNumber: s.fromNumber,
        fromName: s.fromName,
        toNumber: s.toNumber,
        didId: d?.id ?? null,
        answeredByExtensionId: idOf(s.answeredBy),
        talkSeconds: s.talkSeconds,
        spamRisk: spam?.risk ?? null,
        spamInfo: spam && { provider: spam.provider, info: spam.info },
        recordingId: opts.recordingsDir
          ? await linkRecording(tx, opts.recordingsDir, s, linkedid)
          : null,
      })
      .returning({ id: calls.id });
    const involved = [
      ...(idOf(s.caller) ? [{ id: idOf(s.caller)!, role: 'caller' }] : []),
      ...s.rang.flatMap((n) => (idOf(n) ? [{ id: idOf(n)!, role: 'rang' }] : [])),
      ...(idOf(s.answeredBy) ? [{ id: idOf(s.answeredBy)!, role: 'answered' }] : []),
    ];
    if (involved.length)
      await tx
        .insert(callExtensions)
        .values(involved.map((x) => ({ callId: call!.id, extensionId: x.id, role: x.role })))
        .onConflictDoNothing();
  });
  // TODO(M11-T5): webhook call.ended.
}

export type CdrDeps = {
  db: Db;
  log: { error(o: object, msg: string): void; warn(o: object, msg: string): void };
  /** How long after a call's last Cdr event to aggregate it (04 §5.4: 5 s). */
  settleMs?: number;
  /** Where MixMonitor writes (RECORDINGS_DIR); recordings are linked to their calls. */
  recordingsDir?: string;
};

export function watchCdr(d: CdrDeps, ami: Pick<EventEmitter, 'on'>) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const schedule = (linkedid: string) => {
    clearTimeout(timers.get(linkedid));
    timers.set(
      linkedid,
      setTimeout(() => {
        timers.delete(linkedid);
        void aggregateCall(d.db, linkedid, { recordingsDir: d.recordingsDir, log: d.log }).catch(
          (err: unknown) => d.log.error({ err, linkedid }, 'call aggregation failed'),
        );
      }, d.settleMs ?? 5000),
    );
  };
  ami.on('event', (m: AmiMessage) => {
    if (field(m, 'Event') !== 'Cdr') return;
    const row = toCdrRow(m);
    void d.db
      .insert(cdr)
      .values(row)
      .then(() => schedule(row.linkedid))
      .catch((err: unknown) => d.log.error({ err }, 'cdr insert failed'));
  });
  return {
    /** Calls whose aggregation never ran (api down at the time): on AMI connect. */
    async catchUp() {
      const orphans = await d.db
        .selectDistinct({ linkedid: cdr.linkedid })
        .from(cdr)
        .leftJoin(calls, eq(calls.linkedid, cdr.linkedid))
        .where(and(isNull(calls.id), lt(cdr.createdAt, new Date(Date.now() - 60_000))));
      for (const o of orphans)
        await aggregateCall(d.db, o.linkedid, { recordingsDir: d.recordingsDir, log: d.log });
    },
    stop: () => timers.forEach(clearTimeout),
  };
}
