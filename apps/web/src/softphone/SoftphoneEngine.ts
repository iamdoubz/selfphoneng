// SPDX-License-Identifier: AGPL-3.0-or-later
// The browser softphone (05 §5.2): SIP.js over WebSocket to Asterisk, no React in here.
// React reads it through subscribe()/state (useSyncExternalStore in useSoftphone.ts).
import {
  Invitation,
  Inviter,
  Registerer,
  RegistererState,
  SessionState,
  UserAgent,
  Web,
  type Session,
} from 'sip.js';
import type { WebRtcCreds } from '@selfphoneng/shared';

export type RegState = 'off' | 'connecting' | 'registered' | 'error';

export type CallInfo = {
  id: string;
  direction: 'in' | 'out';
  /** The other side's number (SIP user part). */
  remote: string;
  remoteName: string | null;
  /** incoming: ringing here; calling: ringing there; active: talking. */
  state: 'incoming' | 'calling' | 'active';
  answeredAt: number | null;
};

export type EngineState = { reg: RegState; error: string | null; calls: CallInfo[] };

const BACKOFF_S = [2, 4, 8, 16, 30];
const MAX_CALLS = 2;

type Tracked = { session: Session; info: CallInfo; audio: HTMLAudioElement };

export class SoftphoneEngine {
  state: EngineState = { reg: 'off', error: null, calls: [] };
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

  async call(number: string): Promise<void> {
    const target = UserAgent.makeURI(`sip:${encodeURIComponent(number)}@${this.host}`);
    if (!this.ua || !target) throw new Error('Softphone is not started');
    if (this.sessions.size >= MAX_CALLS) throw new Error('Two calls already');
    const inviter = new Inviter(this.ua, target, {
      sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } },
    });
    this.track(inviter, 'out', number, null);
    await inviter.invite();
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
  }

  async answer(id: string): Promise<void> {
    const t = this.sessions.get(id);
    if (!(t?.session instanceof Invitation)) return;
    await t.session.accept({
      sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } },
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

  private track(session: Session, direction: 'in' | 'out', remote: string, name: string | null) {
    const id = session.id;
    const audio = new Audio();
    audio.autoplay = true;
    const info: CallInfo = {
      id,
      direction,
      remote,
      remoteName: name,
      state: direction === 'in' ? 'incoming' : 'calling',
      answeredAt: null,
    };
    this.sessions.set(id, { session, info, audio });
    session.stateChange.addListener((s) => {
      if (s === SessionState.Established) {
        const sdh = session.sessionDescriptionHandler;
        if (sdh instanceof Web.SessionDescriptionHandler) {
          audio.srcObject = sdh.remoteMediaStream;
          void audio.play().catch(() => undefined);
        }
        info.state = 'active';
        info.answeredAt = Date.now();
      }
      if (s === SessionState.Terminated) {
        audio.srcObject = null;
        this.sessions.delete(id);
      }
      this.publishCalls();
    });
    this.publishCalls();
  }
}

/** One engine per tab. */
export const softphone = new SoftphoneEngine();
