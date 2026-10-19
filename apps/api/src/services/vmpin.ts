// SPDX-License-Identifier: AGPL-3.0-or-later
// Voicemail PINs changed from the phone (*97/*98 → mailbox options → change password). Asterisk
// checks the new PIN with sp-vm-pincheck (same rules as the api) and writes it into its own copy
// of the config; VoicemailPasswordChange tells us, and we store it so the next config write keeps
// it instead of putting the old one back. Never logs the PIN.
import type { EventEmitter } from 'node:events';
import { and, eq } from 'drizzle-orm';
import { field, type AmiMessage } from '../ami/events.ts';
import { encrypt, isTrivialPin } from '../crypto/secrets.ts';
import type { Db } from '../db/client.ts';
import { extensions } from '../db/schema.ts';
import { audit } from './audit.ts';

export async function recordPinChange(db: Db, m: AmiMessage): Promise<'saved' | 'refused' | null> {
  if (m.Event !== 'VoicemailPasswordChange' || field(m, 'Context') !== 'default') return null;
  const box = field(m, 'Mailbox') ?? '';
  const pin = field(m, 'NewPassword') ?? '';
  const [e] = await db
    .select({ id: extensions.id, number: extensions.number })
    .from(extensions)
    .where(and(eq(extensions.number, box), eq(extensions.voicemailEnabled, true)));
  if (!e) return null;
  // sp-vm-pincheck refused these already; a second look in case the script is missing.
  if (!/^\d{4,10}$/.test(pin) || isTrivialPin(pin, e.number)) {
    await audit(db, {
      action: 'update',
      entityType: 'extension',
      entityId: e.id,
      summary: `Ignored a weak voicemail PIN set from phone ${e.number}; the old one stays`,
    });
    return 'refused';
  }
  await db
    .update(extensions)
    .set({ voicemailPinEnc: encrypt(pin) })
    .where(eq(extensions.id, e.id));
  await audit(db, {
    action: 'update',
    entityType: 'extension',
    entityId: e.id,
    summary: `Voicemail PIN of ${e.number} changed from the phone`,
  });
  return 'saved';
}

export function watchPinChanges(
  d: { db: Db; log: { error(o: object, msg: string): void }; requestApply: () => void },
  ami: Pick<EventEmitter, 'on'>,
) {
  ami.on('event', (m: AmiMessage) => {
    if (m.Event !== 'VoicemailPasswordChange') return;
    recordPinChange(d.db, m)
      // Either way, rewrite the config from the database: the new PIN, or the old one back.
      .then((r) => r && d.requestApply())
      .catch((err: unknown) => d.log.error({ err }, 'voicemail PIN change failed'));
  });
}
