// SPDX-License-Identifier: AGPL-3.0-or-later
// Voicemail index (04 §5.6). Asterisk records into the spool; this keeps voicemail_messages in step
// with it, tells the owner, and emails them. A mailbox is rescanned on Asterisk's MessageWaiting
// event, which fires whenever a message is left, listened to or deleted (from a phone or from us),
// so there is no file watcher (inotify is unreliable on bind mounts).
import type { EventEmitter } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, isNull, notInArray } from 'drizzle-orm';
import {
  formatNumber,
  VOICEMAIL_FOLDERS,
  type LiveMessage,
  type VoicemailDto,
  type VoicemailFolder,
} from '@selfphoneng/shared';
import { field, type AmiMessage } from '../ami/events.ts';
import type { Db } from '../db/client.ts';
import { extensions, users, voicemailMessages } from '../db/schema.ts';
import { MailNotConfigured, type SendMail } from './mail.ts';
import { getSetting } from './settings.ts';
import { enqueueWebhook } from './webhooks.ts';

export type VoicemailDeps = {
  db: Db;
  /** /var/spool/asterisk/voicemail */
  spoolDir: string;
  ami: { action(fields: Record<string, string>): Promise<unknown> };
  live: { emit(event: 'message', m: LiveMessage): unknown };
  send: SendMail;
  publicHost: string;
  log: { info(o: object, msg: string): void; error(o: object, msg: string): void };
};

type Row = typeof voicemailMessages.$inferSelect;

/** msgNNNN.txt: an INI file with one [message] section. */
export function parseMessageTxt(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-z_]+)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** `"Bob" <102>`, `<102>`, `102`, `Bob`, `Unknown`. */
export function parseCallerId(v = ''): { name: string | null; number: string | null } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]*)>\s*$/.exec(v);
  if (m) return { name: m[1]!.trim() || null, number: m[2]!.trim() || null };
  const s = v.trim();
  if (!s || /^unknown$/i.test(s)) return { name: null, number: null };
  return /^[0-9*#+]+$/.test(s) ? { name: null, number: s } : { name: s, number: null };
}

export const toVoicemailDto = (r: Row): VoicemailDto => ({
  id: r.id,
  folder: r.folder as VoicemailFolder,
  callerNumber: r.callerNumber,
  callerName: r.callerName,
  durationS: r.durationS,
  receivedAt: r.receivedAt.toISOString(),
});

/** Everything in one mailbox's INBOX, Old and Urgent folders. filePath is relative to the spool. */
async function readMailbox(spoolDir: string, ext: string) {
  const found: (Omit<typeof voicemailMessages.$inferInsert, 'extensionId'> & { msgId: string })[] =
    [];
  for (const folder of VOICEMAIL_FOLDERS) {
    const rel = `default/${ext}/${folder}`;
    const names = await readdir(join(spoolDir, rel)).catch(() => [] as string[]);
    for (const n of names.filter((n) => /^msg\d{4}\.txt$/.test(n)).sort()) {
      const info = parseMessageTxt(await readFile(join(spoolDir, rel, n), 'utf8').catch(() => ''));
      if (!info.msg_id) continue; // still being written: the next MessageWaiting picks it up
      const cid = parseCallerId(info.callerid);
      found.push({
        msgId: info.msg_id,
        folder,
        callerName: cid.name,
        callerNumber: cid.number,
        durationS: Number(info.duration) || 0,
        receivedAt: new Date(Number(info.origtime) * 1000),
        filePath: `${rel}/${n.replace(/\.txt$/, '.wav')}`,
      });
    }
  }
  return found;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

type Box = {
  id: string;
  number: string;
  userId: string | null;
  email: string | null;
  voicemailEmail: boolean;
  voicemailAttachAudio: boolean;
  voicemailDeleteAfterEmail: boolean;
};

async function announce(d: VoicemailDeps, box: Box, row: Row) {
  // Every mailbox, with or without a user (the live message is only for the user's own).
  void enqueueWebhook(d.db, 'voicemail.new', {
    ...toVoicemailDto(row),
    extension: box.number,
  }).catch((err: unknown) => d.log.error({ err }, 'webhook enqueue failed'));
  if (box.userId)
    d.live.emit('message', {
      type: 'voicemail.new',
      data: { ...toVoicemailDto(row), userId: box.userId },
    });
  if (!box.voicemailEmail || !box.email) return;
  const tz = await getSetting(d.db, 'general.timezone');
  const from = row.callerName ?? (row.callerNumber ? formatNumber(row.callerNumber) : 'unknown');
  const at = row.receivedAt.toLocaleString('en-US', { timeZone: tz });
  // sv-SE formats as "2026-10-17 15:13:05".
  const stamp = row.receivedAt.toLocaleString('sv-SE', { timeZone: tz }).slice(0, 16);
  try {
    await d.send({
      to: [box.email],
      subject: `New voicemail from ${from} (${mmss(row.durationS)})`,
      text: [
        `Caller: ${row.callerName ?? 'unknown'}`,
        `Number: ${row.callerNumber ? formatNumber(row.callerNumber) : 'unknown'}`,
        `Received: ${at}`,
        `Length: ${mmss(row.durationS)}`,
        '',
        `Listen: https://${d.publicHost}/me/voicemail`,
      ].join('\n'),
      attachments: box.voicemailAttachAudio
        ? [
            {
              filename: `voicemail-${stamp.replace(/[ :]/g, '-')}.wav`,
              path: join(d.spoolDir, row.filePath),
            },
          ]
        : undefined,
    });
  } catch (err) {
    if (!(err instanceof MailNotConfigured))
      d.log.error({ err, ext: box.number, msgId: row.msgId }, 'voicemail email failed');
    return;
  }
  await d.db
    .update(voicemailMessages)
    .set({ emailedAt: new Date() })
    .where(eq(voicemailMessages.id, row.id));
  // Only when the audio went with the email, so the message can't be lost.
  if (box.voicemailDeleteAfterEmail && box.voicemailAttachAudio) {
    await d.ami.action({
      Action: 'VoicemailRemove',
      Context: 'default',
      Mailbox: box.number,
      Folder: row.folder,
      ID: row.msgId,
    });
    await d.db
      .update(voicemailMessages)
      .set({ deletedAt: new Date() })
      .where(eq(voicemailMessages.id, row.id));
  }
}

/** Brings one mailbox's rows in line with its files. New INBOX/Urgent messages are announced. */
export async function scanMailbox(d: VoicemailDeps, number: string) {
  const [box] = await d.db
    .select({
      id: extensions.id,
      number: extensions.number,
      userId: extensions.userId,
      email: users.email,
      voicemailEmail: extensions.voicemailEmail,
      voicemailAttachAudio: extensions.voicemailAttachAudio,
      voicemailDeleteAfterEmail: extensions.voicemailDeleteAfterEmail,
    })
    .from(extensions)
    .leftJoin(users, eq(users.id, extensions.userId))
    .where(eq(extensions.number, number));
  if (!box) return;
  const found = await readMailbox(d.spoolDir, number);
  const known = new Set(
    (
      await d.db
        .select({ msgId: voicemailMessages.msgId })
        .from(voicemailMessages)
        .where(eq(voicemailMessages.extensionId, box.id))
    ).map((r) => r.msgId),
  );
  for (const f of found) {
    const [row] = (await d.db
      .insert(voicemailMessages)
      .values({ ...f, extensionId: box.id })
      .onConflictDoUpdate({
        target: voicemailMessages.msgId,
        set: { folder: f.folder, filePath: f.filePath, deletedAt: null },
      })
      .returning()) as [Row];
    if (!known.has(f.msgId) && f.folder !== 'Old') await announce(d, box, row);
  }
  const seen = found.map((f) => f.msgId);
  await d.db
    .update(voicemailMessages)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(voicemailMessages.extensionId, box.id),
        isNull(voicemailMessages.deletedAt),
        seen.length ? notInArray(voicemailMessages.msgId, seen) : undefined,
      ),
    );
}

/** Rescans a mailbox on every MessageWaiting; one scan at a time per mailbox. */
export function watchVoicemail(d: VoicemailDeps, ami: Pick<EventEmitter, 'on'>) {
  const chains = new Map<string, Promise<void>>();
  const scan = (number: string) => {
    const next = (chains.get(number) ?? Promise.resolve())
      .then(() => scanMailbox(d, number))
      .catch((err: unknown) => d.log.error({ err, ext: number }, 'voicemail scan failed'));
    chains.set(number, next);
    return next;
  };
  ami.on('event', (m: AmiMessage) => {
    if (field(m, 'Event') !== 'MessageWaiting') return;
    const [box, context] = (field(m, 'Mailbox') ?? '').split('@');
    if (context === 'default' && box && /^\d+$/.test(box)) void scan(box);
  });
  return {
    spoolDir: d.spoolDir,
    scan,
    /** Startup and AMI reconnects: messages may have come and gone while we weren't listening. */
    scanAll: async () => {
      const rows = await d.db
        .select({ number: extensions.number })
        .from(extensions)
        .where(eq(extensions.voicemailEnabled, true));
      await Promise.all(rows.map((r) => scan(r.number)));
    },
  };
}
