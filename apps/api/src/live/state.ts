// SPDX-License-Identifier: AGPL-3.0-or-later
// In-memory live state (04 §5.1). Rebuilt from Asterisk on every AMI connect, then kept current
// from AMI events. M2: extension states and registered devices; calls, queues and parking later.
import { EventEmitter } from 'node:events';
import { eq } from 'drizzle-orm';
import type {
  ContactLive,
  ExtensionLive,
  ExtensionState,
  LiveMessage,
  LiveSnapshot,
} from '@selfphoneng/shared';
import type { AmiClient } from '../ami/client.ts';
import { field, type AmiMessage } from '../ami/events.ts';
import type { Db } from '../db/client.ts';
import { extensions, userRuntimeState } from '../db/schema.ts';

/** ExtensionStatus/ExtensionStateList Status is a bit mask (04 §5.1). */
export function stateFromStatus(status: number): ExtensionState {
  if (status < 0 || status === 4) return 'unavailable'; // -1 removed, -2 deleted, 4 unavailable
  if (status & 16) return 'onhold';
  if (status & 8) return status & 1 ? 'ringinuse' : 'ringing';
  if (status & 2) return 'busy';
  if (status & 1) return 'inuse';
  return 'idle';
}

function contactStatus(s: string | undefined): ContactLive['status'] {
  if (s === 'Reachable' || s === 'Avail') return 'reachable';
  if (s === 'Unreachable' || s === 'Unavail') return 'unreachable';
  return 'unknown'; // NonQualified (qualify off, e.g. browsers), Created, Updated, Unknown
}

/** "101" and "101-web" both belong to extension 101; trunks and others don't match. */
export const extOfEndpoint = (endpoint: string): string | null =>
  /^(\d{3,6})(?:-web)?$/.exec(endpoint)?.[1] ?? null;

/** What LiveState needs from AmiClient (tests pass a fake). */
type Ami = {
  actionList: AmiClient['actionList'];
  on(event: string, fn: (m: AmiMessage) => void): unknown;
};

export class LiveState extends EventEmitter<{ message: [LiveMessage] }> {
  private readonly exts = new Map<string, ExtensionLive & { contacts: ContactLive[] }>();
  private amiConnected = false;
  private readonly db: Db;
  private readonly ami: Ami;

  constructor(db: Db, ami: Ami) {
    super();
    this.db = db;
    this.ami = ami;
    ami.on('event', (m: AmiMessage) => this.handleEvent(m));
    ami.on('disconnected', () => this.setAmi(false));
  }

  snapshot(admin: boolean): LiveSnapshot {
    return {
      extensions: [...this.exts.values()].map((e) => this.view(e, admin)),
      ami: { connected: this.amiConnected },
    };
  }

  /** Users see everyone's presence but not their devices (04 §5.2). */
  view(e: ExtensionLive & { contacts: ContactLive[] }, admin: boolean): ExtensionLive {
    const { contacts, ...rest } = e;
    return admin ? { ...rest, contacts } : rest;
  }

  private setAmi(connected: boolean) {
    if (this.amiConnected === connected) return;
    this.amiConnected = connected;
    this.emit('message', { type: 'ami.status', data: { connected } });
  }

  private changed(number: string) {
    const e = this.exts.get(number);
    if (!e) return;
    e.online = e.contacts.length > 0;
    this.emit('message', { type: 'extension.updated', data: e });
  }

  /** Extensions from the DB (call after config changes too, so new users appear). */
  async loadExtensions(): Promise<void> {
    const rows = await this.db
      .select({ number: extensions.number, name: extensions.name, dnd: userRuntimeState.dnd })
      .from(extensions)
      .leftJoin(userRuntimeState, eq(userRuntimeState.extensionId, extensions.id));
    const seen = new Set<string>();
    for (const r of rows) {
      seen.add(r.number);
      const cur = this.exts.get(r.number);
      if (cur && cur.name === r.name && cur.dnd === Boolean(r.dnd)) continue;
      this.exts.set(r.number, {
        number: r.number,
        name: r.name,
        state: cur?.state ?? 'unavailable',
        contacts: cur?.contacts ?? [],
        online: cur?.online ?? false,
        dnd: Boolean(r.dnd),
      });
      this.changed(r.number);
    }
    for (const n of [...this.exts.keys()])
      if (!seen.has(n)) {
        this.exts.delete(n);
        this.emit('message', { type: 'extension.removed', data: { number: n } });
      }
  }

  /** Initial load on every AMI connect (04 §5.1). */
  async loadFromAsterisk(): Promise<void> {
    await this.loadExtensions();
    for (const e of this.exts.values()) e.contacts = [];
    const [states, contacts] = await Promise.all([
      this.ami.actionList({ Action: 'ExtensionStateList' }),
      this.ami.actionList({ Action: 'PJSIPShowContacts' }),
    ]);
    for (const m of states) this.onExtensionStatus(m, false);
    for (const m of contacts) {
      const endpoint = field(m, 'Endpoint') ?? field(m, 'EndpointName') ?? '';
      const ext = extOfEndpoint(endpoint);
      const e = ext ? this.exts.get(ext) : undefined;
      if (!e) continue;
      const rtt = Number(field(m, 'RoundtripUsec'));
      e.contacts.push({
        endpoint,
        uri: field(m, 'Uri') ?? '',
        userAgent: field(m, 'UserAgent') || undefined,
        status: contactStatus(field(m, 'Status')),
        rttMs: rtt > 0 ? Math.round(rtt / 1000) : undefined,
      });
    }
    for (const n of this.exts.keys()) this.changed(n);
    this.setAmi(true);
  }

  handleEvent(m: AmiMessage): void {
    switch (field(m, 'Event')) {
      case 'ExtensionStatus':
        return this.onExtensionStatus(m, true);
      case 'ContactStatus':
        return this.onContactStatus(m);
    }
  }

  private onExtensionStatus(m: AmiMessage, notify: boolean) {
    if (field(m, 'Context') !== 'sp-local-numbers') return;
    const e = this.exts.get(field(m, 'Exten') ?? '');
    if (!e) return;
    e.state = stateFromStatus(Number(field(m, 'Status')));
    if (notify) this.changed(e.number);
  }

  private onContactStatus(m: AmiMessage) {
    const endpoint = field(m, 'EndpointName') ?? field(m, 'AOR') ?? '';
    const e = this.exts.get(extOfEndpoint(endpoint) ?? '');
    if (!e) return;
    const uri = field(m, 'URI') ?? '';
    const rest = e.contacts.filter((c) => c.uri !== uri);
    if (field(m, 'ContactStatus') === 'Removed') e.contacts = rest;
    else {
      const rtt = Number(field(m, 'RoundtripUsec'));
      const prev = e.contacts.find((c) => c.uri === uri);
      e.contacts = [
        ...rest,
        {
          endpoint,
          uri,
          userAgent: prev?.userAgent,
          status: contactStatus(field(m, 'ContactStatus')),
          rttMs: rtt > 0 ? Math.round(rtt / 1000) : prev?.rttMs,
        },
      ];
    }
    this.changed(e.number);
  }
}
