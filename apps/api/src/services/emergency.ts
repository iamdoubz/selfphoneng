// SPDX-License-Identifier: AGPL-3.0-or-later
// Someone dialed 911 (04 §5.3, 06 §6): record it, email, ring the notify phones, tell the
// dashboards. The test button runs the same notifications with TEST in front and dials nothing.
import type { EventEmitter } from 'node:events';
import { eq, inArray } from 'drizzle-orm';
import type { EmergencyCall } from '@selfphoneng/shared';
import { field, type AmiMessage } from '../ami/events.ts';
import type { Db } from '../db/client.ts';
import { emergencyEvents, extensions } from '../db/schema.ts';
import type { SendMail } from './mail.ts';
import { getSetting } from './settings.ts';

export type Notified = { kind: 'email' | 'ring'; to: string; ok: boolean; error?: string };

export type EmergencyDeps = {
  db: Db;
  ami: { action(fields: Record<string, string>): Promise<unknown> };
  live: { emit(event: 'message', m: { type: 'emergency.call'; data: EmergencyCall }): unknown };
  send: SendMail;
  log: { info(o: object, msg: string): void; error(o: object, msg: string): void };
};

export async function notifyEmergency(
  d: EmergencyDeps,
  call: { ext: string; callerId: string; dialed: string; test?: boolean; name?: string },
): Promise<Notified[]> {
  const at = new Date();
  const [ext] = call.ext
    ? await d.db.select().from(extensions).where(eq(extensions.number, call.ext))
    : [];
  const name = ext?.name ?? call.name ?? 'unknown';
  const location = ext?.emergencyLocation ?? null;
  const [row] = call.test
    ? []
    : await d.db
        .insert(emergencyEvents)
        .values({
          extensionNumber: call.ext || 'unknown',
          dialed: call.dialed,
          callerIdUsed: call.callerId,
          location,
        })
        .returning({ id: emergencyEvents.id });

  const notifyIds = await getSetting(d.db, 'emergency.notifyExtensionIds');
  const notifyExts = notifyIds.length
    ? await d.db
        .select({ number: extensions.number, userId: extensions.userId })
        .from(extensions)
        .where(inArray(extensions.id, notifyIds))
    : [];
  // Dashboards first: it's the fastest channel.
  d.live.emit('message', {
    type: 'emergency.call',
    data: {
      ext: call.ext,
      name,
      location,
      callerId: call.callerId,
      at: at.toISOString(),
      test: Boolean(call.test),
      audienceUserIds: notifyExts.flatMap((e) => (e.userId ? [e.userId] : [])),
    },
  });

  const tz = await getSetting(d.db, 'general.timezone');
  const prefix = call.test ? 'TEST ' : '';
  const results: Notified[] = [];
  const emails = await getSetting(d.db, 'emergency.notifyEmails');
  const mail = emails.length
    ? d
        .send({
          to: emails,
          subject: `${prefix}EMERGENCY: 911 dialed from ext ${call.ext || 'unknown'} (${name})`,
          text: [
            call.test
              ? 'This is a TEST of the emergency notifications. No emergency call was made.\n'
              : '',
            `Time: ${at.toLocaleString('en-US', { timeZone: tz })}`,
            `Extension: ${call.ext || 'unknown'} (${name})`,
            `Location: ${location ?? 'not set'}`,
            `Caller ID sent to 911: ${call.callerId || 'none'}`,
            '',
            'Emergency services get the address registered for that caller ID at voip.ms.',
          ].join('\n'),
        })
        .then(
          () => results.push({ kind: 'email', to: emails.join(', '), ok: true }),
          (e: Error) =>
            results.push({ kind: 'email', to: emails.join(', '), ok: false, error: e.message }),
        )
    : Promise.resolve();
  const rings = notifyExts.map((e) =>
    d.ami
      .action({
        Action: 'Originate',
        Channel: `PJSIP/${e.number}`,
        Context: 'sp-emergency-alert',
        Exten: call.ext || '0',
        Priority: '1',
        CallerID: `"${prefix}EMERGENCY 911" <${call.ext || '0'}>`,
        Async: 'true',
      })
      .then(
        () => results.push({ kind: 'ring', to: e.number, ok: true }),
        (err: Error) => results.push({ kind: 'ring', to: e.number, ok: false, error: err.message }),
      ),
  );
  await Promise.all([mail, ...rings]);

  if (row)
    await d.db
      .update(emergencyEvents)
      .set({ notified: results })
      .where(eq(emergencyEvents.id, row.id));
  d.log[results.every((r) => r.ok) ? 'info' : 'error'](
    { ext: call.ext, test: Boolean(call.test), results },
    'emergency notifications',
  );
  return results;
}

/** Listens for the dialplan's UserEvent(SpEmergency,...) (03 §6.14). */
export function watchEmergencies(d: EmergencyDeps, ami: Pick<EventEmitter, 'on'>) {
  ami.on('event', (m: AmiMessage) => {
    if (field(m, 'Event') !== 'UserEvent' || field(m, 'UserEvent') !== 'SpEmergency') return;
    void notifyEmergency(d, {
      ext: field(m, 'Ext') ?? '',
      callerId: field(m, 'CallerId') ?? '',
      dialed: field(m, 'Dialed') ?? '911',
    }).catch((err: unknown) => d.log.error({ err }, 'emergency notification failed'));
  });
}
