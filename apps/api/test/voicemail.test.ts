// SPDX-License-Identifier: AGPL-3.0-or-later
// M4-T2: voicemail index, live event and email (04 §5.6, §10).
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveMessage } from '@selfphoneng/shared';
import { extensions, voicemailMessages, webhookDeliveries, webhooks } from '../src/db/schema.ts';
import { parseCallerId, type watchVoicemail } from '../src/services/voicemail.ts';
import { setSetting } from '../src/services/settings.ts';
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
    if (spool) rmSync(spool, { recursive: true, force: true }); // unset if beforeAll failed
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

  it('spec 10: with transcripts on, the words go in the row, the email and the list', async () => {
    let fail = false;
    const stt = createServer((req, res) => {
      req.resume();
      req.on('end', () =>
        fail ? res.writeHead(500).end('out of memory') : res.end('{"text":" Please call me. "}'),
      );
    });
    await new Promise<void>((ok) => stt.listen(0, '127.0.0.1', ok));
    const url = `http://127.0.0.1:${(stt.address() as AddressInfo).port}/v1`;
    await setSetting(t.db, 'ai.stt', { url, model: 'whisper' });
    await setSetting(t.db, 'ai.voicemailTranscripts', true);
    await t.db
      .insert(webhooks)
      .values({ url: 'https://hooks.example.com/x', secretEnc: 'x', events: ['voicemail.new'] });
    try {
      leave('INBOX', 3, '1792300700-00000004', '<104>');
      await w.scan('101');
      const r = (await rows()).find((x) => x.msgId === '1792300700-00000004')!;
      expect(r.transcript).toBe('Please call me.');
      // A webhook goes off this server: the words stay here (10 §1, 08 §7 #6).
      const [hook] = await t.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.event, 'voicemail.new'));
      expect((hook!.payload as { data: object }).data).toMatchObject({ id: r.id });
      expect((hook!.payload as { data: object }).data).not.toHaveProperty('transcript');
      expect(t.mails.at(-1)!.text).toContain(
        'What they said (automatic, may have mistakes):\nPlease call me.',
      );
      const list = await t.app.inject({
        method: 'GET',
        url: '/api/me/voicemail',
        headers: { ...H, cookie: await t.login('dan@example.com', 'dan-password-123') },
      });
      expect(list.json().items).toContainEqual(
        expect.objectContaining({ id: r.id, transcript: 'Please call me.' }),
      );

      // The speech server failing doesn't hold up the email.
      fail = true;
      leave('INBOX', 4, '1792300800-00000005', '<105>');
      await w.scan('101');
      expect((await rows()).find((x) => x.msgId === '1792300800-00000005')!.transcript).toBeNull();
      expect(t.mails.at(-1)!.text).not.toContain('What they said');
    } finally {
      await setSetting(t.db, 'ai.voicemailTranscripts', false);
      stt.close();
    }
  });
});
