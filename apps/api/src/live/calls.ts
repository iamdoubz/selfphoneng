// SPDX-License-Identifier: AGPL-3.0-or-later
// Calls in progress (04 §5.1): every channel Asterisk tells us about, grouped by Linkedid. Loaded
// from CoreShowChannels on connect, then kept current from channel events.
import type { ActiveCall } from '@selfphoneng/shared';
import { field, type AmiMessage } from '../ami/events.ts';

type Channel = {
  name: string;
  linkedid: string;
  /** ChannelStateDesc: Down, Ring, Ringing, Up, Busy… */
  state: string;
  app: string;
  callerNum: string;
  callerName: string;
  connectedNum: string;
  exten: string;
  held: boolean;
  bridged: boolean;
  createdAt: number;
  /** Uniqueid "epoch.seq": seq orders channels created in the same second. */
  seq: number;
};

const isTrunk = (name: string) => /^PJSIP\/trunk-/.test(name);
/** PJSIP/101-…, PJSIP/101-web-…, Local/101@sp-rg-member-… → 101. */
export const extOfChannel = (name: string) =>
  /^PJSIP\/(\d+)(?:-web)?-[0-9a-f]+$/.exec(name)?.[1] ??
  /^Local\/(\d+)@sp-(?:rg|queue)-member-/.exec(name)?.[1] ??
  null;
const unknown = (v: string | undefined) => (!v || v === '<unknown>' ? '' : v);
const IVR_APPS = new Set(['BackGround', 'Background', 'WaitExten', 'Read']);

export class CallTracker {
  private readonly channels = new Map<string, Channel>();
  /** Per linkedid: dialplan variables (SP_DID…) and when it was first answered. */
  private readonly extra = new Map<
    string,
    { did?: string; direction?: string; rec?: boolean; answeredAt?: number }
  >();
  private readonly emit: (linkedid: string, call: ActiveCall | null) => void;

  constructor(emit: (linkedid: string, call: ActiveCall | null) => void) {
    this.emit = emit;
  }

  list(): ActiveCall[] {
    return [...new Set([...this.channels.values()].map((c) => c.linkedid))]
      .map((l) => this.call(l))
      .filter((c): c is ActiveCall => c !== null)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  channelsOf(linkedid: string): string[] {
    return this.byLinkedid(linkedid).map((c) => c.name);
  }

  /** CoreShowChannel items (initial load). Duration is "HH:MM:SS". */
  load(items: AmiMessage[]): void {
    const before = new Set([...this.channels.values()].map((c) => c.linkedid));
    this.channels.clear();
    for (const m of items) {
      if (field(m, 'Event') !== 'CoreShowChannel') continue;
      const [h = 0, mi = 0, s = 0] = (field(m, 'Duration') ?? '0:0:0').split(':').map(Number);
      this.upsert(m, { createdAt: Date.now() - ((h * 60 + mi) * 60 + s) * 1000 });
      const c = this.channels.get(field(m, 'Channel') ?? '');
      if (c) {
        c.app = field(m, 'Application') ?? '';
        c.bridged = Boolean(field(m, 'BridgeId'));
      }
    }
    const now = new Set([...this.channels.values()].map((c) => c.linkedid));
    for (const l of before) if (!now.has(l)) this.emit(l, null);
    for (const l of now) this.emit(l, this.call(l));
  }

  handle(m: AmiMessage): void {
    const ev = field(m, 'Event');
    const name = field(m, 'Channel') ?? '';
    const linkedid = field(m, 'Linkedid') ?? '';
    switch (ev) {
      case 'Newchannel':
        this.upsert(m, { createdAt: Date.now() });
        break;
      case 'Newstate':
      case 'NewCallerid':
      case 'NewConnectedLine':
        // Only Newchannel creates: Asterisk can send a NewCallerid after a channel's Hangup.
        if (!this.channels.has(name)) return;
        this.upsert(m);
        break;
      case 'Newexten': {
        const c = this.channels.get(name);
        if (c) c.app = field(m, 'Application') ?? c.app;
        else return;
        break;
      }
      case 'BridgeEnter':
      case 'BridgeLeave': {
        const c = this.channels.get(name);
        if (!c) return;
        c.bridged = ev === 'BridgeEnter';
        const x = this.extraOf(c.linkedid);
        if (
          c.bridged &&
          x.answeredAt === undefined &&
          this.byLinkedid(c.linkedid).filter((y) => y.bridged).length >= 2
        )
          x.answeredAt = Date.now();
        break;
      }
      case 'Hold':
      case 'Unhold': {
        const c = this.channels.get(name);
        if (!c) return;
        c.held = ev === 'Hold';
        break;
      }
      case 'VarSet': {
        const v = field(m, 'Variable') ?? '';
        const value = field(m, 'Value') ?? '';
        if (!/^(?:__)?SP_(?:DID|DIRECTION|REC)$/.test(v) || !this.byLinkedid(linkedid).length) return;
        const x = this.extraOf(linkedid);
        if (v.endsWith('DID')) x.did = value || x.did;
        else if (v.endsWith('DIRECTION'))
          x.direction = x.direction ?? value; // the first one wins
        else x.rec = Boolean(value);
        break;
      }
      case 'Hangup': {
        const c = this.channels.get(name);
        if (!c) return;
        this.channels.delete(name);
        if (!this.byLinkedid(c.linkedid).length) {
          this.extra.delete(c.linkedid);
          this.emit(c.linkedid, null);
          return;
        }
        this.emit(c.linkedid, this.call(c.linkedid));
        return;
      }
      default:
        return;
    }
    const l = this.channels.get(name)?.linkedid ?? linkedid;
    if (l) this.emit(l, this.call(l));
  }

  private extraOf(linkedid: string) {
    let x = this.extra.get(linkedid);
    if (!x) this.extra.set(linkedid, (x = {}));
    return x;
  }

  private byLinkedid(linkedid: string) {
    return [...this.channels.values()]
      .filter((c) => c.linkedid === linkedid)
      .sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq);
  }

  private upsert(m: AmiMessage, init: Partial<Channel> = {}) {
    const name = field(m, 'Channel') ?? '';
    if (!name) return;
    const prev = this.channels.get(name);
    this.channels.set(name, {
      name,
      linkedid: field(m, 'Linkedid') ?? prev?.linkedid ?? name,
      state: field(m, 'ChannelStateDesc') ?? prev?.state ?? 'Down',
      app: prev?.app ?? '',
      callerNum: unknown(field(m, 'CallerIDNum')) || (prev?.callerNum ?? ''),
      callerName: unknown(field(m, 'CallerIDName')) || (prev?.callerName ?? ''),
      connectedNum: unknown(field(m, 'ConnectedLineNum')) || (prev?.connectedNum ?? ''),
      exten: field(m, 'Exten') ?? prev?.exten ?? '',
      held: prev?.held ?? false,
      bridged: prev?.bridged ?? false,
      createdAt: prev?.createdAt ?? init.createdAt ?? Date.now(),
      seq: prev?.seq ?? Number(field(m, 'Uniqueid')?.split('.')[1] ?? 0),
    });
  }

  private call(linkedid: string): ActiveCall | null {
    const chans = this.byLinkedid(linkedid);
    const first = chans[0];
    if (!first) return null;
    const x = this.extra.get(linkedid) ?? {};
    const exts = [
      ...new Set(chans.map((c) => extOfChannel(c.name)).filter((e): e is string => !!e)),
    ];
    const direction =
      (x.direction as ActiveCall['direction'] | undefined) ??
      (isTrunk(first.name)
        ? 'inbound'
        : chans.some((c) => isTrunk(c.name))
          ? 'outbound'
          : 'internal');
    const callerExt = extOfChannel(first.name);
    const otherExt = exts.find((e) => e !== callerExt);
    const apps = new Set(chans.map((c) => c.app));
    const state: ActiveCall['state'] = chans.some((c) => c.held)
      ? 'hold'
      : apps.has('VoiceMail')
        ? 'voicemail'
        : [...apps].some((a) => IVR_APPS.has(a))
          ? 'ivr'
          : apps.has('Queue')
            ? 'queued'
            : apps.has('Park') || apps.has('ParkedCall')
              ? 'parked'
              : chans.filter((c) => c.bridged && c.state === 'Up').length >= 2
                ? 'talking'
                : 'ringing';
    return {
      linkedid,
      startedAt: new Date(first.createdAt).toISOString(),
      ...(x.answeredAt ? { answeredAt: new Date(x.answeredAt).toISOString() } : {}),
      direction,
      from: {
        number: callerExt ?? first.callerNum,
        ...(first.callerName ? { name: first.callerName } : {}),
      },
      to: {
        number:
          (direction === 'inbound' ? x.did : undefined) ??
          otherExt ??
          (first.connectedNum || first.exten),
      },
      ...(x.did ? { did: x.did } : {}),
      state,
      extensions: exts,
      channels: chans.map((c) => c.name),
      recording: Boolean(x.rec),
    };
  }
}
