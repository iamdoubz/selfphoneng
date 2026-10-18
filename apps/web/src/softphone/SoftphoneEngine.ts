// SPDX-License-Identifier: AGPL-3.0-or-later
// The browser softphone (05 §5.2): SIP.js over WebSocket to Asterisk, no React in here.
// React reads it through subscribe()/state (useSyncExternalStore in SoftphoneDock.tsx).
import {
  Invitation,
  Inviter,
  Registerer,
  RegistererState,
  SessionState,
  UserAgent,
  Web,
  type Notification as SipNotification,
  type Session,
} from 'sip.js';
import type { WebRtcCreds } from '@selfphoneng/shared';
import { beep } from './sounds.ts';

/** elsewhere: another tab of this browser has the softphone (one tab only, leader.ts). */
export type RegState = 'off' | 'connecting' | 'registered' | 'error' | 'elsewhere';

export type CallInfo = {
  id: string;
  direction: 'in' | 'out';
  /** The other side's number (SIP user part). */
  remote: string;
  remoteName: string | null;
  /** incoming: ringing here; calling: ringing there; active: talking. */
  state: 'incoming' | 'calling' | 'active';
  answeredAt: number | null;
  muted: boolean;
  held: boolean;
  /** Packet loss > 5 % or jitter > 50 ms over the last 5 s. */
  poorQuality: boolean;
};

export type EngineState = {
  reg: RegState;
  error: string | null;
  calls: CallInfo[];
  inputDeviceId: string | null;
  outputDeviceId: string | null;
};

const BACKOFF_S = [2, 4, 8, 16, 30];
const MAX_CALLS = 2;

type Tracked = {
  session: Session;
  info: CallInfo;
  audio: HTMLAudioElement;
  stats?: ReturnType<typeof setInterval>;
};

export class SoftphoneEngine {
  state: EngineState = {
    reg: 'off',
    error: null,
    calls: [],
    inputDeviceId: null,
    outputDeviceId: null,
  };
  private listeners = new Set<() => void>();
  private ua: UserAgent | null = null;
  private registerer: Registerer | null = null;
  private host = '';
  private sessions = new Map<string, Tracked>();
  private retry: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private stopped = true;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  private set(patch: Partial<EngineState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  private publishCalls() {
    this.set({ calls: [...this.sessions.values()].map((t) => ({ ...t.info })) });
  }

  setElsewhere() {
    this.set({ reg: 'elsewhere', error: null });
  }

  async start(creds: WebRtcCreds): Promise<void> {
    await this.stop();
    this.stopped = false;
    this.host = new URL(creds.sipUri.replace(/^sip:/, 'sip://')).hostname;
    this.set({ reg: 'connecting', error: null });
    const ua = new UserAgent({
      uri: UserAgent.makeURI(creds.sipUri),
      transportOptions: { server: creds.wsUrl },
      authorizationUsername: creds.authUser,
      authorizationPassword: creds.password,
      displayName: creds.displayName,
      contactParams: { transport: creds.wsUrl.startsWith('wss:') ? 'wss' : 'ws' },
      sessionDescriptionHandlerFactoryOptions: {
        peerConnectionConfiguration: { iceServers: creds.iceServers },
      },
      logLevel: 'warn',
      delegate: {
        onInvite: (inv) => this.incoming(inv),
        onDisconnect: (err) => {
          if (err && !this.stopped) this.reconnect();
        },
      },
    });
    this.ua = ua;
    const registerer = new Registerer(ua, { expires: 300 });
    this.registerer = registerer;
    registerer.stateChange.addListener((s) => {
      if (this.stopped) return;
      if (s === RegistererState.Registered) {
        this.attempt = 0;
        this.set({ reg: 'registered', error: null });
      } else if (this.state.reg === 'registered') this.set({ reg: 'connecting' });
    });
    try {
      await ua.start();
      await this.register();
    } catch (e) {
      this.set({ reg: 'error', error: (e as Error).message });
      this.reconnect();
    }
  }

  private register() {
    return this.registerer!.register({
      requestDelegate: {
        onReject: (res) =>
          this.set({
            reg: 'error',
            error: `Registration refused (${res.message.statusCode} ${res.message.reasonPhrase})`,
          }),
      },
    });
  }

  /** Transport lost: reconnect with backoff 2 → 30 s, then register again. */
  private reconnect() {
    clearTimeout(this.retry);
    if (this.stopped || !this.ua) return;
    if (this.state.reg !== 'error') this.set({ reg: 'connecting' });
    const s = BACKOFF_S[Math.min(this.attempt++, BACKOFF_S.length - 1)]!;
    this.retry = setTimeout(() => {
      if (this.stopped || !this.ua) return;
      this.ua
        .reconnect()
        .then(() => this.register())
        .catch(() => this.reconnect());
    }, s * 1000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    for (const id of [...this.sessions.keys()]) await this.hangup(id).catch(() => undefined);
    await this.registerer?.unregister().catch(() => undefined);
    await this.ua?.stop().catch(() => undefined);
    this.ua = null;
    this.registerer = null;
    this.set({ reg: 'off', error: null, calls: [] });
  }

  private constraints(): MediaStreamConstraints {
    const id = this.state.inputDeviceId;
    return { audio: id ? { deviceId: { exact: id } } : true, video: false };
  }

  private uri(number: string) {
    const u = UserAgent.makeURI(`sip:${encodeURIComponent(number)}@${this.host}`);
    if (!u) throw new Error(`Can't call ${number}`);
    return u;
  }

  /** Puts every other talking call on hold first (call waiting, consult calls). */
  private async holdOthers(except?: string) {
    for (const t of this.sessions.values())
      if (t.info.id !== except && t.info.state === 'active' && !t.info.held)
        await this.hold(t.info.id, true);
  }

  /** Returns the new call's id. */
  async call(number: string): Promise<string> {
    if (!this.ua) throw new Error('Softphone is not started');
    if (this.sessions.size >= MAX_CALLS) throw new Error('Two calls already');
    await this.holdOthers();
    const inviter = new Inviter(this.ua, this.uri(number), {
      sessionDescriptionHandlerOptions: { constraints: this.constraints() },
    });
    this.track(inviter, 'out', number, null);
    await inviter.invite();
    return inviter.id;
  }

  private incoming(inv: Invitation) {
    if (this.sessions.size >= MAX_CALLS) {
      void inv.reject({ statusCode: 486 });
      return;
    }
    this.track(
      inv,
      'in',
      inv.remoteIdentity.uri.user ?? '',
      inv.remoteIdentity.displayName || null,
    );
    // Paging/intercom (03 sp-sub-autoanswer): answer after a short beep.
    if (/answer-after=0/.test(inv.request.getHeader('Call-Info') ?? '') && this.sessions.size === 1)
      void beep().then(() => this.answer(inv.id));
  }

  async answer(id: string): Promise<void> {
    const t = this.sessions.get(id);
    if (!(t?.session instanceof Invitation)) return;
    await this.holdOthers(id);
    await t.session.accept({
      sessionDescriptionHandlerOptions: { constraints: this.constraints() },
    });
  }

  async decline(id: string): Promise<void> {
    const t = this.sessions.get(id);
    if (t?.session instanceof Invitation) await t.session.reject({ statusCode: 486 });
  }

  /** bye() once talking; before that, cancel (outgoing) or reject (incoming). */
  async hangup(id: string): Promise<void> {
    const s = this.sessions.get(id)?.session;
    if (!s) return;
    if (s.state === SessionState.Established) await s.bye();
    else if (s instanceof Inviter) await s.cancel();
    else if (s instanceof Invitation) await s.reject();
  }

  private sdh(id: string) {
    const sdh = this.sessions.get(id)?.session.sessionDescriptionHandler;
    return sdh instanceof Web.SessionDescriptionHandler ? sdh : null;
  }

  /** re-INVITE with a=sendonly (hold) or a=sendrecv (resume). */
  async hold(id: string, on: boolean): Promise<void> {
    const t = this.sessions.get(id);
    if (!t || t.session.state !== SessionState.Established || t.info.held === on) return;
    t.session.sessionDescriptionHandlerOptionsReInvite = {
      ...t.session.sessionDescriptionHandlerOptionsReInvite,
      hold: on,
    } as Web.SessionDescriptionHandlerOptions;
    await t.session.invite();
    this.sdh(id)?.enableReceiverTracks(!on);
    this.sdh(id)?.enableSenderTracks(!on && !t.info.muted);
    t.info.held = on;
    this.publishCalls();
  }

  mute(id: string, on: boolean): void {
    const t = this.sessions.get(id);
    if (!t) return;
    this.sdh(id)?.enableSenderTracks(!on && !t.info.held);
    t.info.muted = on;
    this.publishCalls();
  }

  /** RFC 4733 through the RTCDTMFSender; SIP INFO when the browser can't (canInsertDTMF false). */
  dtmf(id: string, digit: string): void {
    if (this.sdh(id)?.sendDtmf(digit)) return;
    void this.sessions
      .get(id)
      ?.session.info({
        requestOptions: {
          body: {
            contentDisposition: 'render',
            contentType: 'application/dtmf-relay',
            content: `Signal=${digit}\r\nDuration=160`,
          },
        },
      })
      .catch(() => undefined);
  }

  /** RFC 5589: once the NOTIFY says the transfer worked (2xx sipfrag), the transferor hangs up. */
  private referOptions(s: Session) {
    return {
      onNotify: (n: SipNotification) => {
        void n.accept();
        if (/^SIP\/2\.0 2\d\d/m.test(n.request.body ?? '') && s.state === SessionState.Established)
          void s.bye().catch(() => undefined);
      },
    };
  }

  async blindTransfer(id: string, target: string): Promise<void> {
    const s = this.sessions.get(id)?.session;
    if (s) await s.refer(this.uri(target), this.referOptions(s));
  }

  /** REFER with Replaces: the other side of `id` is connected to the other side of `consultId`. */
  async attendedTransfer(id: string, consultId: string): Promise<void> {
    const s = this.sessions.get(id)?.session;
    const consult = this.sessions.get(consultId)?.session;
    if (s && consult) await s.refer(consult, this.referOptions(s));
  }

  async setOutputDevice(deviceId: string | null): Promise<void> {
    this.set({ outputDeviceId: deviceId });
    for (const t of this.sessions.values())
      await t.audio.setSinkId?.(deviceId ?? '').catch(() => undefined);
  }

  /** Used for the next call. */
  setInputDevice(deviceId: string | null): void {
    this.set({ inputDeviceId: deviceId });
  }

  private track(session: Session, direction: 'in' | 'out', remote: string, name: string | null) {
    const id = session.id;
    const audio = new Audio();
    audio.autoplay = true;
    if (this.state.outputDeviceId)
      void audio.setSinkId?.(this.state.outputDeviceId).catch(() => undefined);
    const info: CallInfo = {
      id,
      direction,
      remote,
      remoteName: name,
      state: direction === 'in' ? 'incoming' : 'calling',
      answeredAt: null,
      muted: false,
      held: false,
      poorQuality: false,
    };
    const tracked: Tracked = { session, info, audio };
    this.sessions.set(id, tracked);
    session.stateChange.addListener((s) => {
      if (s === SessionState.Established && info.state !== 'active') {
        const sdh = this.sdh(id);
        if (sdh) {
          audio.srcObject = sdh.remoteMediaStream;
          void audio.play().catch(() => undefined);
          tracked.stats = this.watchQuality(sdh.peerConnection, info);
        }
        info.state = 'active';
        info.answeredAt = Date.now();
      }
      if (s === SessionState.Terminated) {
        clearInterval(tracked.stats);
        audio.srcObject = null;
        this.sessions.delete(id);
      }
      this.publishCalls();
    });
    this.publishCalls();
  }

  /** Every 5 s: loss and jitter of what we receive. */
  private watchQuality(pc: RTCPeerConnection | undefined, info: CallInfo) {
    let last = { lost: 0, received: 0 };
    return setInterval(() => {
      void pc?.getStats().then((report) => {
        report.forEach((s: RTCInboundRtpStreamStats) => {
          if (s.type !== 'inbound-rtp' || s.kind !== 'audio') return;
          const lost = (s.packetsLost ?? 0) - last.lost;
          const received = (s.packetsReceived ?? 0) - last.received;
          last = { lost: s.packetsLost ?? 0, received: s.packetsReceived ?? 0 };
          const poor =
            !info.held && (lost / Math.max(1, lost + received) > 0.05 || (s.jitter ?? 0) > 0.05);
          if (poor !== info.poorQuality) {
            info.poorQuality = poor;
            this.publishCalls();
          }
        });
      });
    }, 5000);
  }
}

/** One engine per tab. */
export const softphone = new SoftphoneEngine();

/** dataTransfer type for dragging a call card onto a person in People (blind transfer). */
export const CALL_DRAG = 'application/x-selfphoneng-call';
