// SPDX-License-Identifier: AGPL-3.0-or-later
// Our own AMI client (04 §4): connect, log in, reconnect forever, match replies by ActionID.
import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import type { FastifyBaseLogger } from 'fastify';
import { AmiParser, field, fields, serialize, type AmiMessage } from './events.ts';

export class AmiDisconnectedError extends Error {
  constructor() {
    super('AMI disconnected');
  }
}
export class AmiActionError extends Error {
  readonly response: AmiMessage;
  constructor(response: AmiMessage) {
    super(`AMI action failed: ${field(response, 'Message') ?? 'unknown error'}`);
    this.response = response;
  }
}

type Pending = {
  resolve: (m: AmiMessage) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  list?: { items: AmiMessage[]; done: (items: AmiMessage[]) => void };
};

export type AmiOptions = {
  host: string;
  port: number;
  username: string;
  secret: string;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;
  /** Overridable for tests. */
  backoffMs?: number[];
  pingEveryMs?: number;
  pingTimeoutMs?: number;
};

const DEFAULT_BACKOFF = [1, 2, 4, 8, 16, 30].map((s) => s * 1000);

export class AmiClient extends EventEmitter {
  private readonly o: Required<AmiOptions>;
  private socket: Socket | null = null;
  private readonly parser = new AmiParser();
  private readonly pending = new Map<string, Pending>();
  private nextId = 0;
  private attempt = 0;
  private connected = false;
  private stopped = true;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(opts: AmiOptions) {
    super();
    this.o = {
      backoffMs: DEFAULT_BACKOFF,
      pingEveryMs: 20_000,
      pingTimeoutMs: 10_000,
      ...opts,
    };
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.destroy();
  }

  isConnected(): boolean {
    return this.connected;
  }

  private connect(): void {
    this.parser.reset();
    const s = new Socket();
    this.socket = s;
    s.setEncoding('utf8');
    s.setNoDelay(true);
    s.on('data', (chunk: string) => {
      for (const msg of this.parser.push(chunk)) this.onMessage(msg);
    });
    s.on('error', (err) => this.o.logger.debug({ err: err.message }, 'ami socket error'));
    s.on('close', () => this.onClose(s));
    s.connect(this.o.port, this.o.host, () => void this.login());
  }

  private async login(): Promise<void> {
    try {
      // Login fields carry the secret: send() never logs them (04 §4).
      await this.send({
        Action: 'Login',
        Username: this.o.username,
        Secret: this.o.secret,
        Events: 'on',
      });
    } catch (err) {
      this.o.logger.error({ err: (err as Error).message }, 'ami login failed');
      this.socket?.destroy();
      return;
    }
    this.connected = true;
    this.attempt = 0;
    this.o.logger.info({ banner: this.parser.banner }, 'ami connected');
    this.startPing();
    this.emit('connected');
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      this.action({ Action: 'Ping' }, { timeoutMs: this.o.pingTimeoutMs }).catch(() => {
        this.o.logger.warn('ami ping timed out, reconnecting');
        this.socket?.destroy();
      });
    }, this.o.pingEveryMs);
  }

  private onClose(s: Socket): void {
    if (s !== this.socket) return;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const wasConnected = this.connected;
    this.connected = false;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new AmiDisconnectedError());
      this.pending.delete(id);
    }
    if (wasConnected) {
      this.o.logger.warn('ami disconnected');
      this.emit('disconnected');
    }
    if (this.stopped) return;
    const delay = this.o.backoffMs[Math.min(this.attempt, this.o.backoffMs.length - 1)]!;
    this.attempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private onMessage(msg: AmiMessage): void {
    const id = field(msg, 'ActionID');
    const p = id ? this.pending.get(id) : undefined;
    if (p && id) {
      if (msg.Response !== undefined) {
        if (field(msg, 'Response') === 'Error') {
          this.finish(id);
          p.reject(new AmiActionError(msg));
        } else if (!p.list) {
          this.finish(id);
          p.resolve(msg);
        } else if (field(msg, 'EventList') !== 'start') {
          // A list action that answered without a list (e.g. nothing to report).
          this.finish(id);
          p.list.done([]);
        }
        return;
      }
      if (p.list && msg.Event !== undefined) {
        if (field(msg, 'EventList') === 'Complete') {
          this.finish(id);
          p.list.done(p.list.items);
        } else {
          p.list.items.push(msg);
        }
        return;
      }
    }
    const name = field(msg, 'Event');
    if (name) {
      this.emit('event', msg);
      this.emit(`event:${name}`, msg);
    }
  }

  private finish(id: string): void {
    const p = this.pending.get(id);
    if (p) clearTimeout(p.timer);
    this.pending.delete(id);
  }

  private send(
    fields: Record<string, string>,
    opts: { timeoutMs?: number; list?: (items: AmiMessage[]) => void } = {},
  ): Promise<AmiMessage> {
    const s = this.socket;
    if (!s || s.destroyed) return Promise.reject(new AmiDisconnectedError());
    const id = `sp-${++this.nextId}`;
    const wire = serialize({ ...fields, ActionID: id });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`AMI action ${fields.Action} timed out`));
      }, opts.timeoutMs ?? 10_000);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        list: opts.list ? { items: [], done: opts.list } : undefined,
      });
      s.write(wire);
    });
  }

  action(fields: Record<string, string>, opts?: { timeoutMs?: number }): Promise<AmiMessage> {
    if (!this.connected) return Promise.reject(new AmiDisconnectedError());
    return this.send(fields, opts);
  }

  /** Sends a list action and collects its events up to the "...Complete" event. */
  actionList(fields: Record<string, string>, opts?: { timeoutMs?: number }): Promise<AmiMessage[]> {
    if (!this.connected) return Promise.reject(new AmiDisconnectedError());
    return new Promise((resolve, reject) => {
      this.send(fields, { ...opts, list: resolve }).catch((e: Error) => {
        // Some list actions answer an empty list with an error, e.g. "No Contacts found".
        if (e instanceof AmiActionError && /^No .* found/i.test(field(e.response, 'Message') ?? ''))
          resolve([]);
        else reject(e);
      });
    });
  }

  /** Action: Command. Returns the CLI output lines joined with \n. */
  async command(cmd: string): Promise<string> {
    const r = await this.action({ Action: 'Command', Command: cmd });
    return fields(r, 'Output').join('\n');
  }
}
