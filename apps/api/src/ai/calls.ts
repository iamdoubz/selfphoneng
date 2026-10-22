// SPDX-License-Identifier: AGPL-3.0-or-later
// Call transcripts and summaries (spec 10 §3). With ai.callTranscripts on, sp-sub-record also
// writes <call>-in.wav (what the caller said) and <call>-out.wav (what they heard), so who said
// what needs no speaker detection. A job writes each side out, merges them by time, asks ai.llm
// for a summary (ai.callSummaries), and deletes the two side files: the mixed recording stays.
import { access, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { recordings } from '../db/schema.ts';
import { getSetting } from '../services/settings.ts';
import { AiError, chat, transcribeSegments } from './client.ts';

export type Line = { side: 'caller' | 'other'; at: number; text: string };

/** The two side files next to a recording (relative, like recordings.file_path). */
export const sideFiles = (filePath: string) => {
  const base = filePath.replace(/\.wav$/, '');
  return [`${base}-in.wav`, `${base}-out.wav`] as const;
};

/**
 * Where someone speaks in a 16-bit mono WAV (MixMonitor's: 44-byte header), in seconds: 20 ms
 * frames louder than the line's noise, joined across pauses under `gap` s. Whisper's own timings
 * drift across the long silences one side of a call has while the other talks, so each stretch is
 * transcribed on its own, from its known start.
 */
export function speechStretches(wav: Buffer, gap = 0.6): { from: number; to: number }[] {
  const rate = wav.readUInt32LE(24) || 8000;
  const frame = Math.round(rate / 50) * 2; // bytes in 20 ms
  const levels: number[] = [];
  for (let i = 44; i + frame <= wav.length; i += frame) {
    let sum = 0;
    for (let j = i; j < i + frame; j += 2) sum += Math.abs(wav.readInt16LE(j));
    levels.push(sum / (frame / 2));
  }
  // ponytail: a fixed share of the loudest speech, with a floor for silent lines; tune if a noisy
  // line splits badly.
  const loud = [...levels].sort((a, b) => a - b)[Math.floor(levels.length * 0.95)] ?? 0;
  const threshold = Math.max(120, loud / 10);
  const out: { from: number; to: number }[] = [];
  levels.forEach((l, i) => {
    if (l < threshold) return;
    const at = i * 0.02;
    const last = out.at(-1);
    if (last && at - last.to < gap) last.to = at + 0.02;
    else out.push({ from: at, to: at + 0.02 });
  });
  const end = levels.length * 0.02;
  return out
    .filter((s) => s.to - s.from >= 0.2) // a click, not a word
    .map((s) => ({ from: Math.max(0, s.from - 0.2), to: Math.min(end, s.to + 0.2) }));
}

/** Seconds `from`–`to` of a WAV as a WAV of its own. */
export function wavSlice(wav: Buffer, from: number, to: number): Buffer {
  const bytesPerSec = wav.readUInt32LE(28) || 16000;
  const at = (s: number) => 44 + Math.min(wav.length - 44, Math.round(s * bytesPerSec) & ~1);
  const data = wav.subarray(at(from), at(to));
  const head = Buffer.from(wav.subarray(0, 44));
  head.writeUInt32LE(36 + data.length, 4);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** One side of a call, stretch by stretch, each line at its time in the whole call. */
async function transcribeSide(stt: Parameters<typeof transcribeSegments>[0], wav: Buffer) {
  const lines: Omit<Line, 'side'>[] = [];
  for (const s of speechStretches(wav))
    for (const seg of await transcribeSegments(stt, wavSlice(wav, s.from, s.to)))
      lines.push({ at: Math.round((s.from + seg.at) * 10) / 10, text: seg.text });
  return lines;
}

/** Both sides in time order (the files start together, so their timings line up). */
export const mergeSides = (caller: Omit<Line, 'side'>[], other: Omit<Line, 'side'>[]): Line[] =>
  [
    ...caller.map((l) => ({ side: 'caller' as const, ...l })),
    ...other.map((l) => ({ side: 'other' as const, ...l })),
  ].sort((a, b) => a.at - b.at || (a.side === 'caller' ? -1 : 1));

/** "Caller: …" lines, cut to fit a small model's context. */
export function transcriptText(lines: Line[], max = 12_000): string {
  const text = lines
    .map((l) => `${l.side === 'caller' ? 'Caller' : 'Other side'}: ${l.text}`)
    .join('\n');
  // ponytail: a long call is cut, not chunked; summarize in parts if calls this long matter.
  return text.length > max ? `${text.slice(0, max)}\n[the rest of the call is cut]` : text;
}

const SUMMARY_PROMPT = `You summarize business phone calls from their transcript. Write in the \
language of the call, in plain text, no markdown headings:
- 1 to 3 sentences on what the call was about and what was agreed;
- then a line "Action items:" and one "- " line per item (who does what), or "Action items: none".
Use only what the transcript says. The transcript is automatic and may have mistakes.`;

/** Recordings the job still has to do: recent, finished a moment ago, not tried yet. */
const pending = (db: Db) =>
  db
    .select({ id: recordings.id, filePath: recordings.filePath })
    .from(recordings)
    .where(
      and(
        isNull(recordings.aiDoneAt),
        gt(recordings.startedAt, sql`now() - interval '2 days'`),
        lt(recordings.createdAt, sql`now() - interval '20 seconds'`), // files closed
      ),
    )
    .orderBy(asc(recordings.startedAt))
    .limit(20);

const exists = (f: string) =>
  access(f).then(
    () => true,
    () => false,
  );

/** One run: every pending recording, one at a time (the GPU is shared). */
export async function transcribeCalls(d: {
  db: Db;
  dir: string;
  log: { error(o: object, m: string): void };
}): Promise<number> {
  const stt = await getSetting(d.db, 'ai.stt');
  if (!stt || !(await getSetting(d.db, 'ai.callTranscripts'))) return 0;
  const llm = (await getSetting(d.db, 'ai.callSummaries'))
    ? await getSetting(d.db, 'ai.llm')
    : null;
  let done = 0;
  for (const r of await pending(d.db)) {
    const files = sideFiles(r.filePath).map((f) => join(d.dir, f));
    const finish = (set: Partial<typeof recordings.$inferInsert>) =>
      d.db
        .update(recordings)
        .set({ aiDoneAt: new Date(), ...set })
        .where(eq(recordings.id, r.id));
    if (!(await exists(files[0]!)) || !(await exists(files[1]!))) {
      await finish({ aiError: 'Recorded before call transcripts were on' });
      continue;
    }
    let lines: Line[];
    try {
      const [caller, other] = [
        await transcribeSide(stt, await readFile(files[0]!)),
        await transcribeSide(stt, await readFile(files[1]!)),
      ];
      lines = mergeSides(caller, other);
    } catch (err) {
      // The AI stack being down or busy: try again on the next run. Anything else: give up.
      if (err instanceof AiError && /Can't reach|didn't answer/.test(err.message)) {
        d.log.error({ err, recording: r.id }, 'call transcript: speech to text unreachable');
        return done;
      }
      await finish({ aiError: err instanceof Error ? err.message : String(err) });
      continue;
    }
    let summary: string | null = null;
    let aiError: string | null = null;
    if (llm && lines.length)
      try {
        summary = await chat(
          llm,
          [
            { role: 'system', content: SUMMARY_PROMPT },
            { role: 'user', content: transcriptText(lines) },
          ],
          { maxTokens: 2000, timeoutMs: 300_000 },
        );
      } catch (err) {
        aiError = `Summary: ${err instanceof Error ? err.message : String(err)}`;
      }
    await finish({ transcript: lines, summary, aiError });
    for (const f of files) await rm(f, { force: true });
    done++;
  }
  return done;
}
