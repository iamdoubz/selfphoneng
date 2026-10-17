// SPDX-License-Identifier: AGPL-3.0-or-later
// Everything render() needs, loaded in one go (03 §1). render() itself does no I/O.
import type { Db } from '../db/client.ts';
import { getAllSettings } from '../services/settings.ts';

export type Snapshot = {
  /** "YYYY-MM-DD" in general.timezone; render() never reads the clock. */
  today: string;
  settings: Awaited<ReturnType<typeof getAllSettings>>;
};

export function todayIn(timezone: string, now = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
}

export async function loadSnapshot(db: Db, now = new Date()): Promise<Snapshot> {
  const settings = await getAllSettings(db);
  return { today: todayIn(settings['general.timezone'], now), settings };
}
