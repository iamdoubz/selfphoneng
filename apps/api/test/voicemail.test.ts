// SPDX-License-Identifier: AGPL-3.0-or-later
// M4-T2: voicemail index, live event and email (04 §5.6, §10).
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveMessage } from '@selfphoneng/shared';
import { extensions, voicemailMessages } from '../src/db/schema.ts';
import { parseCallerId, type watchVoicemail } from '../src/services/voicemail.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe('parseCallerId', () => {
  it.each([
    ['"Bob Smith" <13125550000>', { name: 'Bob Smith', number: '13125550000' }],
    ['<102>', { name: null, number: '102' }],
    ['Bob <102>', { name: 'Bob', number: '102' }],
    ['13125550000', { name: null, number: '13125550000' }],
    ['Unknown', { name: null, number: null }],
    ['', { name: null, number: null }],
  ])('%s', (v, want) => expect(parseCallerId(v)).toEqual(want));
});

const tick = () => new Promise((r) => setTimeout(r, 50));

describe.skipIf(!hasTestDb)('voicemail watcher', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let w: ReturnType<typeof watchVoicemail>;
  let spool: string;
  let userId: string;
  const live: LiveMessage[] = [];

  /** Writes a message the way app_voicemail leaves it. */
  function leave(folder: string, n: number, msgId: string, callerid: string, duration = 7) {
    const dir = join(spool, 'default', '101', folder);
    mkdirSync(dir, { recursive: true });
    const base = join(dir, `msg${String(n).padStart(4, '0')}`);
    writeFileSync(`${base}.wav`, 'RIFF fake audio');
    writeFileSync(
      `${base}.txt`,
      `;\n; Message Information file\n;\n[message]\norigmailbox=101\ncallerid=${callerid}\norigtime=1792300385\nmsg_id=${msgId}\nflag=\nduration=${duration}\n`,
    );
  }
  const rows = () => t.db.select().from(voicemailMessages).orderBy(voicemailMessages.msgId);

  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    const cookie = await t.login(ADMIN.email, ADMIN.password);
    userId = (await t.addUser('dan@example.com', 'dan-password-123')).id;
    await t.app.inject({
      method: 'POST',
      url: '/api/extensions',
      headers: { ...H, cookie },
      payload: { number: '101', name: 'Dan Doe', userId },
    });
    spool = t.spoolDir;
    t.live.on('message', (m) => live.push(m));
    w = t.app.voicemail;
  });
  afterAll(async () => {
    await t?.close();
    rmSync(spool, { recursive: true, force: true });
  });

  it('a new message: indexed, owner told, emailed with the audio (on MessageWaiting)', async () => {
    leave('INBOX', 0, '1792300385-00000000', '"Bob Smith" <13125550000>', 75);
    t.ami.events.emit('event', { Event: 'MessageWaiting', Mailbox: '101@default', New: '1' });
    await tick();
    await w.scan('101'); // waits for the event's scan too (same mailbox chain)
    const [r] = await rows();
    expect(r).toMatchObject({
      folder: 'INBOX',
      callerName: 'Bob Smith',
      callerNumber: '13125550000',
      durationS: 75,
      filePath: 'default/101/INBOX/msg0000.wav',
      deletedAt: null,
    });
    expect(r!.receivedAt.getTime()).toBe(1792300385_000);
    expect(r!.emailedAt).not.toBeNull();
    expect(live.filter((m) => m.type === 'voicemail.new')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ id: r!.id, userId }) }),
    ]);
    expect(t.mails).toHaveLength(1);
    const mail = t.mails[0]!;
    expect(mail.to).toEqual(['dan@example.com']);
    expect(mail.subject).toBe('New voicemail from Bob Smith (1:15)');
    expect(mail.text).toContain('Number: (312) 555-0000');
    expect(mail.text).toContain('https://pbx.test/me/voicemail');
    expect(mail.attachments).toEqual([
      {
        filename: expect.stringMatching(/^voicemail-\d{4}-\d\d-\d\d-\d\d-\d\d\.wav$/),
        path: join(spool, 'default/101/INBOX/msg0000.wav'),
      },
    ]);
  });

  it('rescans are idempotent: no second email or event', async () => {
    await w.scan('101');
    expect(t.mails).toHaveLength(1);
    expect(live.filter((m) => m.type === 'voicemail.new')).toHaveLength(1);
  });

  it('listened to on the phone (INBOX → Old): folder and path follow', async () => {
    mkdirSync(join(spool, 'default/101/Old'), { recursive: true });
    for (const ext of ['wav', 'txt'])
      renameSync(
        join(spool, `default/101/INBOX/msg0000.${ext}`),
        join(spool, `default/101/Old/msg0000.${ext}`),
      );
    await w.scan('101');
    expect((await rows())[0]).toMatchObject({
      folder: 'Old',
      filePath: 'default/101/Old/msg0000.wav',
    });
  });

  it('deleted on the phone: the row is marked deleted', async () => {
    rmSync(join(spool, 'default/101/Old'), { recursive: true });
    await w.scan('101');
    expect((await rows())[0]!.deletedAt).not.toBeNull();
  });

  it('delete-after-email removes it through AMI; no email setting means no email', async () => {
    await t.db
      .update(extensions)
      .set({ voicemailDeleteAfterEmail: true })
      .where(eq(extensions.number, '101'));
    leave('INBOX', 0, '1792300400-00000001', '<102>');
    await w.scan('101');
    expect(t.ami.actions.at(-1)).toEqual({
      Action: 'VoicemailRemove',
      Context: 'default',
      Mailbox: '101',
      Folder: 'INBOX',
      ID: '1792300400-00000001',
    });
    const r = (await rows()).find((x) => x.msgId === '1792300400-00000001')!;
    expect(r.deletedAt).not.toBeNull();

    await t.db
      .update(extensions)
      .set({ voicemailEmail: false, voicemailDeleteAfterEmail: false })
      .where(eq(extensions.number, '101'));
    leave('INBOX', 1, '1792300500-00000002', 'Unknown');
    const before = t.mails.length;
    await w.scan('101');
    expect(t.mails).toHaveLength(before);
    expect(live.filter((m) => m.type === 'voicemail.new')).toHaveLength(3);
  });

  it('a failed email is logged, the message stays indexed and is not marked emailed', async () => {
    await t.db.update(extensions).set({ voicemailEmail: true }).where(eq(extensions.number, '101'));
    t.mail.fail = 'smtp down';
    leave('INBOX', 2, '1792300600-00000003', '<103>');
    await w.scan('101');
    t.mail.fail = null;
    const r = (await rows()).find((x) => x.msgId === '1792300600-00000003')!;
    expect(r).toMatchObject({ emailedAt: null, deletedAt: null });
  });
});
