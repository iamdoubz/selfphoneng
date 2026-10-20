// SPDX-License-Identifier: AGPL-3.0-or-later
// The System page's event log (05 §2): things the system noticed, newest first. Admin edits are
// the audit log's job, not this one's.
import type { EventEmitter } from 'node:events';
import { eq } from 'drizzle-orm';
import type { LiveMessage, SystemEventDto } from '@selfphoneng/shared';
import type { Db } from '../db/client.ts';
import { systemEvents, trunks } from '../db/schema.ts';

export type SystemEvent = Pick<SystemEventDto, 'severity' | 'code' | 'source' | 'message'>;
type Log = { error(o: object, m: string): void };

/** Never throws: an event that can't be written is logged and dropped. */
export async function logEvent(db: Db, e: SystemEvent, log?: Log): Promise<void> {
  try {
    await db.insert(systemEvents).values(e);
  } catch (err) {
    log?.error({ err, event: e.code }, 'system event not saved');
  }
}

const REGISTRATION: Record<string, string> = {
  registered: 'registered',
  rejected: 'was rejected (wrong username or password?)',
  unregistered: 'is not registered',
  unknown: 'is in an unknown state',
};

/** Trunk registration changes, 911 calls, Asterisk going away and coming back, config errors. */
export function watchEvents(
  db: Db,
  live: { on(e: 'message', fn: (m: LiveMessage) => void): unknown },
  ami: Pick<EventEmitter, 'on'> & { isConnected(): boolean },
  log: Log,
) {
  const add = (e: SystemEvent) => void logEvent(db, e, log);
  const trunkState = new Map<string, string>();
  let restartRequired = false;
  // null until the first connect, so starting up isn't logged as "reachable again".
  let amiUp: boolean | null = ami.isConnected() ? true : null;

  ami.on('connected', () => {
    if (amiUp === false)
      add({
        severity: 'info',
        code: 'telephony.up',
        source: 'Telephony',
        message: 'Asterisk is reachable again',
      });
    amiUp = true;
  });
  ami.on('disconnected', () => {
    if (amiUp)
      add({
        severity: 'error',
        code: 'telephony.down',
        source: 'Telephony',
        message: 'Lost the connection to Asterisk (stopped or restarting)',
      });
    amiUp = false;
  });

  live.on('message', (m) => {
    if (m.type === 'trunk.updated') {
      const prev = trunkState.get(m.data.trunkId);
      trunkState.set(m.data.trunkId, m.data.registration);
      if (!prev || prev === m.data.registration) return;
      const up = m.data.registration === 'registered';
      void (async () => {
        const [t] = await db
          .select({ name: trunks.name })
          .from(trunks)
          .where(eq(trunks.id, m.data.trunkId));
        add({
          severity: up ? 'info' : 'warning',
          code: up ? 'trunk.up' : 'trunk.down',
          source: 'Trunk',
          message: `Trunk ${t?.name ?? m.data.trunkId} ${REGISTRATION[m.data.registration]}`,
        });
      })().catch((err: unknown) => log.error({ err }, 'trunk event failed'));
    } else if (m.type === 'emergency.call') {
      const who = `${m.data.ext} ${m.data.name}`;
      add(
        m.data.test
          ? {
              severity: 'info',
              code: 'emergency.test',
              source: 'Emergency',
              message: 'Emergency notifications tested',
            }
          : {
              severity: 'error',
              code: 'emergency.call',
              source: 'Emergency',
              message: `${who} dialed 911 (caller ID ${m.data.callerId}${m.data.location ? `, ${m.data.location}` : ''})`,
            },
      );
    } else if (m.type === 'system.configApplied') {
      if (!m.data.ok)
        add({
          severity: 'error',
          code: 'config.failed',
          source: 'Configuration',
          message: `Writing Asterisk's configuration failed: ${m.data.error ?? 'unknown error'}`,
        });
      if (m.data.restartRequired && !restartRequired)
        add({
          severity: 'warning',
          code: 'telephony.restartNeeded',
          source: 'Configuration',
          message: 'SIP ports, transports or the public IP changed: telephony needs a restart',
        });
      restartRequired = m.data.restartRequired;
    }
  });
}
