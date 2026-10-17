// SPDX-License-Identifier: AGPL-3.0-or-later
// AmiClient against an in-process fake AMI server.
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AmiParser, serialize } from './events.ts';
import { AmiActionError, AmiClient, AmiDisconnectedError, type AmiOptions } from './client.ts';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

type Action = Record<string, string>;
type Handler = (a: Action, reply: (f: Action) => void, raw: (s: string) => void) => void;

/** A fake Asterisk: banner, password check on Login, then `handler` answers each action. */
async function fakeAmi(handler: Handler, port = 0) {
  const sockets = new Set<Socket>();
  const logins: Action[] = [];
  const server = createServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.setEncoding('utf8');
    s.write('Asterisk Call Manager/13.0.0\r\n');
    const p = new AmiParser();
    p.push('Asterisk Call Manager/13.0.0\r\n'); // client→server traffic has no banner
    s.on('data', (d: string) => {
      for (const m of p.push(d)) {
        const a = m as Action;
        const reply = (f: Action) => s.write(serialize({ ...f, ActionID: a.ActionID! }));
        if (a.Action !== 'Login') handler(a, reply, (raw) => s.write(raw));
        else {
          logins.push(a);
          reply(
            a.Secret === 'right'
              ? { Response: 'Success', Message: 'Authentication accepted' }
              : { Response: 'Error', Message: 'Authentication failed' },
          );
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    logins,
    broadcast: (f: Action) => sockets.forEach((s) => s.write(serialize(f))),
    dropAll: () => sockets.forEach((s) => s.destroy()),
    close: () =>
      new Promise<void>((r) => {
        sockets.forEach((s) => s.destroy());
        server.close(() => r());
      }),
  };
}

const standard: Handler = (a, reply, raw) => {
  if (a.Action === 'Command')
    raw(
      `Response: Success\r\nActionID: ${a.ActionID}\r\nMessage: Command output follows\r\nOutput: line a\r\nOutput: line b\r\n\r\n`,
    );
  else if (a.Action === 'Ping') reply({ Response: 'Success', Ping: 'Pong' });
  else reply({ Response: 'Error', Message: `Invalid/unknown command: ${a.Action}` });
};

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function setup(handler: Handler, extra: Partial<AmiOptions> = {}) {
  const srv = await fakeAmi(handler);
  const ami = new AmiClient({
    host: '127.0.0.1',
    port: srv.port,
    username: 'u',
    secret: 'right',
    logger: silent,
    backoffMs: [20, 40],
    ...extra,
  });
  cleanups.push(
    () => srv.close(),
    () => ami.stop(),
  );
  return { srv, ami };
}

const once = (ami: AmiClient, ev: string) => new Promise((r) => ami.once(ev, r));
const until = async (cond: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; !cond(); await new Promise((r) => setTimeout(r, 10)))
    if (Date.now() > end) throw new Error('timeout');
};

describe('AmiClient', () => {
  it('logs in with Events: on and emits connected', async () => {
    const { srv, ami } = await setup(standard);
    ami.start();
    await once(ami, 'connected');
    expect(ami.isConnected()).toBe(true);
    expect(srv.logins[0]).toMatchObject({
      Action: 'Login',
      Username: 'u',
      Secret: 'right',
      Events: 'on',
      ActionID: 'sp-1',
    });
  });

  it('command() joins repeated Output lines; errors reject with AmiActionError', async () => {
    const { ami } = await setup(standard);
    ami.start();
    await once(ami, 'connected');
    expect(await ami.command('core show version')).toBe('line a\nline b');
    await expect(ami.action({ Action: 'Nope' })).rejects.toBeInstanceOf(AmiActionError);
  });

  it('collects list actions until EventList: Complete, and maps "No … found" to []', async () => {
    const { srv, ami } = await setup((a, reply) => {
      if (a.Action === 'CoreShowChannels') {
        reply({ Response: 'Success', EventList: 'start', Message: 'Channels will follow' });
        reply({ Event: 'CoreShowChannel', Channel: 'PJSIP/101-0001' });
        reply({ Event: 'CoreShowChannel', Channel: 'PJSIP/102-0002' });
        reply({ Event: 'CoreShowChannelsComplete', EventList: 'Complete', ListItems: '2' });
      } else if (a.Action === 'PJSIPShowContacts')
        reply({ Response: 'Error', Message: 'No Contacts found' });
      else reply({ Response: 'Error', Message: 'Permission denied' });
    });
    ami.start();
    await once(ami, 'connected');
    const events: string[] = [];
    ami.on('event', (m) => events.push(String(m.Event)));
    const list = await ami.actionList({ Action: 'CoreShowChannels' });
    expect(list.map((m) => m.Channel)).toEqual(['PJSIP/101-0001', 'PJSIP/102-0002']);
    expect(await ami.actionList({ Action: 'PJSIPShowContacts' })).toEqual([]);
    await expect(ami.actionList({ Action: 'QueueStatus' })).rejects.toBeInstanceOf(AmiActionError);
    expect(events).toEqual([]); // list items don't leak out as normal events
    srv.broadcast({ Event: 'ExtensionStatus', Exten: '101', Status: '1' });
    await until(() => events.length === 1);
  });

  it('emits event and event:<Name>', async () => {
    const { srv, ami } = await setup(standard);
    ami.start();
    await once(ami, 'connected');
    const got = once(ami, 'event:ContactStatus');
    srv.broadcast({ Event: 'ContactStatus', AOR: '101', ContactStatus: 'Reachable' });
    await expect(got).resolves.toMatchObject({ AOR: '101', ContactStatus: 'Reachable' });
  });

  it('rejects pending actions on disconnect, then reconnects with backoff', async () => {
    const { srv, ami } = await setup(() => {}); // never answers
    ami.start();
    await once(ami, 'connected');
    const pending = ami.action({ Action: 'Status' });
    const disconnected = once(ami, 'disconnected');
    srv.dropAll();
    await expect(pending).rejects.toBeInstanceOf(AmiDisconnectedError);
    await disconnected;
    expect(ami.isConnected()).toBe(false);
    await expect(ami.action({ Action: 'Ping' })).rejects.toBeInstanceOf(AmiDisconnectedError);
    await once(ami, 'connected');
    expect(srv.logins).toHaveLength(2);
  });

  it('keeps retrying while Asterisk is down', async () => {
    const { srv, ami } = await setup(standard);
    ami.start();
    await once(ami, 'connected');
    await srv.close();
    await new Promise((r) => setTimeout(r, 150)); // several refused attempts
    const back = await fakeAmi(standard, srv.port);
    cleanups.push(() => back.close());
    await once(ami, 'connected');
    expect(back.logins).toHaveLength(1);
  });

  it('times out actions, and reconnects when Ping gets no answer', async () => {
    const { srv, ami } = await setup(() => {}, { pingEveryMs: 50, pingTimeoutMs: 50 });
    ami.start();
    await once(ami, 'connected');
    await expect(ami.action({ Action: 'Status' }, { timeoutMs: 30 })).rejects.toThrow(/timed out/);
    await once(ami, 'disconnected');
    await once(ami, 'connected');
    expect(srv.logins.length).toBeGreaterThanOrEqual(2);
  });

  it('never connects with a wrong secret, but keeps trying', async () => {
    const { srv, ami } = await setup(standard, { secret: 'wrong' });
    let connected = false;
    ami.on('connected', () => (connected = true));
    ami.start();
    await until(() => srv.logins.length >= 2);
    expect(connected).toBe(false);
  });
});
