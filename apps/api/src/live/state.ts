// SPDX-License-Identifier: AGPL-3.0-or-later
// In-memory live state (04 §5.1). Rebuilt from Asterisk on every AMI connect, then kept current
// from AMI events: extension states and registered devices, calls, queues, parked calls.
import { EventEmitter } from 'node:events';
import { eq } from 'drizzle-orm';
import type {
  ContactLive,
  ExtensionLive,
  ExtensionState,
  LiveMessage,
  LiveSnapshot,
  TrunkLive,
} from '@selfphoneng/shared';
import type { AmiClient } from '../ami/client.ts';
import { field, type AmiMessage } from '../ami/events.ts';
import type { Db } from '../db/client.ts';
import { extensions, queues, trunks, userRuntimeState } from '../db/schema.ts';
import { CallTracker } from './calls.ts';
import { ParkingTracker } from './parking.ts';
import { QueueTracker } from './queues.ts';

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

/** "trunk-<uuid>", "trunk-<uuid>-reg" → the trunk id. */
export const trunkOfObject = (name: string): string | null =>
  /^trunk-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-reg)?$/.exec(
    name,
  )?.[1] ?? null;

/** OutboundRegistrationDetail Status: Registered, Rejected, Unregistered, Stopped, … */
function registrationFrom(s: string | undefined): TrunkLive['registration'] {
  if (s === 'Registered') return 'registered';
  if (s === 'Rejected') return 'rejected';
  if (s === 'Unregistered' || s === 'Stopped') return 'unregistered';
  return 'unknown';
}

/** What LiveState needs from AmiClient (tests pass a fake). */
type Ami = {
  actionList: AmiClient['actionList'];
  action(fields: Record<string, string>): Promise<unknown>;
  on(event: string, fn: (m: AmiMessage) => void): unknown;
};

export class LiveState extends EventEmitter<{ message: [LiveMessage] }> {
  private readonly exts = new Map<string, ExtensionLive & { contacts: ContactLive[] }>();
  private readonly trunks = new Map<string, TrunkLive>();
  amiConnected = false;
  /** Calls in progress (admins see them on the dashboard). */
  readonly calls = new CallTracker((linkedid, call) =>
    this.emit(
      'message',
      call ? { type: 'call.updated', data: call } : { type: 'call.removed', data: { linkedid } },
    ),
  );
  /** Waiting callers and agents (admins, and each queue's agents). */
  readonly queues = new QueueTracker((number, q) =>
    this.emit(
      'message',
      q ? { type: 'queue.updated', data: q } : { type: 'queue.removed', data: { number } },
    ),
  );
  /** Parked calls (everyone). */
  readonly parking = new ParkingTracker((slot, p) =>
    this.emit(
      'message',
      p ? { type: 'parked.updated', data: p } : { type: 'parked.removed', data: { slot } },
    ),
  );
  private readonly db: Db;
  private readonly ami: Ami;

  constructor(db: Db, ami: Ami) {
    super();
    this.db = db;
    this.ami = ami;
    ami.on('event', (m: AmiMessage) => this.handleEvent(m));
    ami.on('disconnected', () => this.setAmi(false));
  }

  /** `myExts`: a user's own extension numbers (they see the queues they're an agent of). */
  snapshot(admin: boolean, myExts: string[] = []): LiveSnapshot {
    return {
      extensions: [...this.exts.values()].map((e) => this.view(e, admin)),
      queues: this.queues
        .list()
        .filter((q) => admin || q.members.some((m) => myExts.includes(m.ext))),
      parked: this.parking.list(),
      ...(admin
        ? {
            trunks: [...this.trunks.values()].map((t) => ({ ...t })),
            calls: this.calls.list(),
          }
        : {}),
      ami: { connected: this.amiConnected },
    };
  }

  /** Users see everyone's presence but not their devices (04 §5.2). */
  view(e: ExtensionLive & { contacts: ContactLive[] }, admin: boolean): ExtensionLive {
    const { contacts, ...rest } = e;
    return admin ? { ...rest, contacts } : rest;
  }

  /** A desk phone or phone app (not the browser) is registered for this extension. */
  deskOnline(number: string): boolean {
    return (
      this.exts
        .get(number)
        ?.contacts.some((c) => c.endpoint === number && c.status !== 'unreachable') ?? false
    );
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

  /** Extensions and trunks from the DB (call after config changes too, so new ones appear). */
  async loadFromDb(): Promise<void> {
    await this.loadExtensions();
    await this.loadTrunks();
  }

  private async loadTrunks(): Promise<void> {
    const rows = await this.db
      .select({ id: trunks.id })
      .from(trunks)
      .where(eq(trunks.enabled, true));
    const seen = new Set(rows.map((r) => r.id));
    for (const { id } of rows)
      if (!this.trunks.has(id)) {
        this.trunks.set(id, {
          trunkId: id,
          registration: 'unknown',
          reachable: false,
          lastChange: new Date().toISOString(),
        });
        this.trunkChanged(id);
      }
    for (const id of [...this.trunks.keys()])
      if (!seen.has(id)) {
        this.trunks.delete(id);
        this.emit('message', { type: 'trunk.removed', data: { trunkId: id } });
      }
  }

  private trunkChanged(id: string, patch: Partial<TrunkLive> = {}) {
    const t = this.trunks.get(id);
    if (!t) return;
    const changed = Object.entries(patch).some(([k, v]) => t[k as keyof TrunkLive] !== v);
    if (changed) Object.assign(t, patch, { lastChange: new Date().toISOString() });
    if (changed || !Object.keys(patch).length)
      this.emit('message', { type: 'trunk.updated', data: { ...t } });
  }

  /**
   * Registration status of every trunk. Registry events can't tell two sub-accounts on the
   * same server apart (same Username and Domain), so any Registry event re-reads the list.
   * The response carries the auth sections too, password included: never log it.
   */
  async refreshRegistrations(): Promise<void> {
    const list = await this.ami.actionList({ Action: 'PJSIPShowRegistrationsOutbound' });
    const status = new Map<string, TrunkLive['registration']>();
    for (const m of list) {
      if (field(m, 'Event') !== 'OutboundRegistrationDetail') continue;
      const id = trunkOfObject(field(m, 'ObjectName') ?? '');
      if (id) status.set(id, registrationFrom(field(m, 'Status')));
    }
    for (const id of this.trunks.keys())
      this.trunkChanged(id, { registration: status.get(id) ?? 'unknown' });
  }

  /** Static trunk contacts aren't in PJSIPShowContacts; the endpoint detail has their status. */
  private async refreshReachable(id: string): Promise<number | null> {
    const list = await this.ami.actionList({
      Action: 'PJSIPShowEndpoint',
      Endpoint: `trunk-${id}`,
    });
    const c = list.find((m) => field(m, 'Event') === 'ContactStatusDetail');
    const reachable = field(c ?? {}, 'Status') === 'Reachable';
    this.trunkChanged(id, { reachable });
    const rtt = Number(field(c ?? {}, 'RoundtripUsec'));
    return reachable && rtt > 0 ? Math.round(rtt / 1000) : null;
  }

  /** POST /api/trunks/:id/test: qualify now, then read registration and reachability. */
  async testTrunk(
    id: string,
    { waitMs = 1500, qualify = true } = {},
  ): Promise<{ live: TrunkLive; rttMs: number | null }> {
    if (qualify) {
      await this.ami.action({ Action: 'PJSIPQualify', Endpoint: `trunk-${id}` }).catch(() => {});
      await new Promise((r) => setTimeout(r, waitMs)); // the OPTIONS answer arrives asynchronously
    }
    await this.refreshRegistrations();
    const rttMs = await this.refreshReachable(id);
    const live = this.trunks.get(id);
    if (!live) throw new Error('trunk is not loaded (disabled?)');
    return { live: { ...live }, rttMs };
  }

  /** Extensions from the DB. */
  private async loadExtensions(): Promise<void> {
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

  /** Queues from the DB and app_queue (on connect, and after each config apply). */
  async refreshQueues(): Promise<void> {
    const defs = await this.db
      .select({ id: queues.id, number: queues.number, name: queues.name })
      .from(queues);
    // QueueStatus errors when app_queue has no queues yet (the apply is still on its way).
    const items = defs.length
      ? await this.ami.actionList({ Action: 'QueueStatus' }).catch(() => [])
      : [];
    this.queues.load(defs, items);
  }

  /** Initial load on every AMI connect (04 §5.1). */
  async loadFromAsterisk(): Promise<void> {
    await this.loadFromDb();
    await this.refreshRegistrations();
    await Promise.all([...this.trunks.keys()].map((id) => this.refreshReachable(id)));
    for (const e of this.exts.values()) e.contacts = [];
    const [states, contacts, channels, parked] = await Promise.all([
      this.ami.actionList({ Action: 'ExtensionStateList' }),
      this.ami.actionList({ Action: 'PJSIPShowContacts' }),
      this.ami.actionList({ Action: 'CoreShowChannels' }),
      this.ami.actionList({ Action: 'ParkedCalls' }).catch(() => []), // errors when none
    ]);
    this.calls.load(channels);
    this.parking.load(parked);
    for (const p of this.parking.list()) this.calls.setParked(p.linkedid, true);
    await this.refreshQueues();
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
    this.calls.handle(m);
    this.queues.handle(m);
    this.parking.handle(m);
    switch (field(m, 'Event')) {
      case 'ExtensionStatus':
        return this.onExtensionStatus(m, true);
      case 'ContactStatus':
        return this.onContactStatus(m);
      case 'Registry':
        if (field(m, 'ChannelType') === 'PJSIP')
          void this.refreshRegistrations().catch(() => undefined); // AMI dropped: reconnect reloads
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
    const trunk = trunkOfObject(endpoint);
    if (trunk) {
      const s = field(m, 'ContactStatus');
      if (s === 'Reachable' || s === 'Unreachable' || s === 'Removed')
        this.trunkChanged(trunk, { reachable: s === 'Reachable' });
      return;
    }
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
