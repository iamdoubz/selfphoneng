// SPDX-License-Identifier: AGPL-3.0-or-later
// System → Diagnostics (08 §2.6). insideChecks: what this server can tell about itself (settings,
// DNS, listening transports, the audio port range). networkTest: the probe (apps/probe) tests it
// from outside, the only way to know what a phone on mobile data or the SIP provider can reach.
import { randomBytes } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import { resolve4 } from 'node:dns/promises';
import { BlockList, isIPv4 } from 'node:net';
import type { DiagnosticCheck, NetworkTestDto } from '@selfphoneng/shared';
import type { AmiClient } from '../ami/client.ts';
import type { Config } from '../config.ts';
import { decrypt } from '../crypto/secrets.ts';
import type { Db } from '../db/client.ts';
import { detectPublicIp } from '../jobs.ts';
import { getAllSettings } from './settings.ts';

export type DiagDeps = {
  db: Db;
  config: Pick<Config, 'PUBLIC_HOSTNAME' | 'RTP_PORT_START' | 'RTP_PORT_END'>;
  ami: Pick<AmiClient, 'isConnected' | 'command'>;
  /** Overridable in tests. */
  lookupPublicIp?: () => Promise<string | null>;
  resolveHost?: (host: string) => Promise<string[]>;
  fetchProbe?: typeof fetch;
};

const PRIVATE = new BlockList();
for (const [a, b] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
] as const)
  PRIVATE.addSubnet(a, b, 'ipv4');

const inNets = (ip: string, nets: string[]) => {
  const list = new BlockList();
  for (const n of nets) {
    const [a, b] = n.split('/');
    list.addSubnet(a!, Number(b), 'ipv4');
  }
  return list.check(ip, 'ipv4');
};

const check = (
  id: string,
  label: string,
  status: DiagnosticCheck['status'],
  detail: string,
  fix?: string,
): DiagnosticCheck => ({ id, label, status, detail, ...(fix && { fix }) });

/** Even ports in the range that something else already holds (RTP takes even ones). */
async function busyRtpPorts(start: number, end: number): Promise<number> {
  const ports: number[] = [];
  for (let p = start + (start % 2); p <= end; p += 2) ports.push(p);
  let busy = 0;
  // ponytail: binds every even port once, 200 at a time (~1 s for 10 000 ports).
  for (let i = 0; i < ports.length; i += 200)
    await Promise.all(
      ports.slice(i, i + 200).map(
        (port) =>
          new Promise<void>((done) => {
            const s = createSocket('udp4');
            s.once('error', () => (busy++, s.close(), done()));
            s.bind(port, () => s.close(done));
          }),
      ),
    );
  return busy;
}

export async function insideChecks(d: DiagDeps): Promise<DiagnosticCheck[]> {
  const s = await getAllSettings(d.db);
  const host = d.config.PUBLIC_HOSTNAME;
  const out: DiagnosticCheck[] = [];
  const setIp = s['network.publicIp'];
  const seenIp = await (d.lookupPublicIp ?? detectPublicIp)();
  const ip = setIp ?? seenIp;

  if (!setIp)
    out.push(
      check(
        'public-ip',
        'Public IP',
        'fail',
        "Not set. Phones outside your network are given the server's private address, so their calls fail or have no sound.",
        `Settings → Network → Public IP: ${seenIp ?? "this server's internet address"}, then restart telephony (System).`,
      ),
    );
  else if (seenIp && seenIp !== setIp)
    out.push(
      check(
        'public-ip',
        'Public IP',
        'fail',
        `Set to ${setIp}, but this server reaches the internet from ${seenIp}.`,
        `Settings → Network → Public IP: ${seenIp}, then restart telephony. If it keeps changing, turn on "Re-check the public IP".`,
      ),
    );
  else
    out.push(
      check(
        'public-ip',
        'Public IP',
        seenIp ? 'ok' : 'warn',
        seenIp ? setIp : `${setIp} (couldn't look it up to compare: no internet?)`,
      ),
    );

  const names = await (d.resolveHost ?? resolve4)(host).catch(() => [] as string[]);
  if (!names.length)
    out.push(
      check(
        'dns',
        `DNS for ${host}`,
        'fail',
        `${host} doesn't resolve. Phones and the browser find the server by this name.`,
        `At your DNS provider, add an A record: ${host} → ${ip ?? 'your public IP'}.`,
      ),
    );
  else if (ip && !names.includes(ip))
    out.push(
      check(
        'dns',
        `DNS for ${host}`,
        'fail',
        `${host} points at ${names.join(', ')}, not ${ip}.`,
        `Point the A record at ${ip}. With Cloudflare, set it to "DNS only" (grey cloud): its proxy carries web pages, not phone calls (SIP).`,
      ),
    );
  else out.push(check('dns', `DNS for ${host}`, 'ok', `${host} → ${names.join(', ')}`));

  const nets = s['network.localNets'];
  const lan = s['network.lanIp'];
  if (lan && !inNets(lan, nets))
    out.push(
      check(
        'local-nets',
        'Local networks',
        'fail',
        `The server's LAN address ${lan} isn't in them (${nets.join(', ') || 'none'}).`,
        `Settings → Network: add ${lan.replace(/\.\d+$/, '.0')}/24 (or your LAN's range) to the local networks.`,
      ),
    );
  else out.push(check('local-nets', 'Local networks', 'ok', nets.join(', ') || 'none'));

  out.push(
    s['sip.restrictPhonesToLocalNets']
      ? check(
          'phone-acl',
          'Where phones can sign in from',
          'warn',
          `Only from ${[...nets, ...s['sip.extraAllowedNets']].join(', ')}. Phone apps on mobile data, or phones at home, are refused.`,
          'Settings → Security: untick "Only accept desk phones from the networks below", or add the networks they call from.',
        )
      : check('phone-acl', 'Where phones can sign in from', 'ok', 'Anywhere, with their password'),
  );
  if (s['provisioning.lanOnly'])
    out.push(
      check(
        'prov-lan',
        'Phone setup files',
        'warn',
        'Only phones on the local networks get them: the Linphone QR code fails on mobile data.',
        'Settings → Security: untick "Only to phones on the local networks" while setting up phones elsewhere.',
      ),
    );

  const port = s['sip.udpPort'];
  if (!d.ami.isConnected())
    out.push(
      check(
        'sip',
        'SIP',
        'fail',
        "Telephony (Asterisk) isn't reachable.",
        'Check that the asterisk container runs: docker compose ps, then docker compose logs asterisk.',
      ),
    );
  else {
    const t = await d.ami.command('pjsip show transports').catch(() => '');
    const want = [
      ['transport-udp', `UDP ${port}`],
      ...(s['sip.tcpEnabled'] ? [['transport-tcp', `TCP ${port}`]] : []),
      ...(s['sip.tlsEnabled'] ? [['transport-tls', `TLS ${s['sip.tlsPort']}`]] : []),
    ];
    const missing = want.filter(([name]) => !t.includes(name!)).map(([, what]) => what);
    out.push(
      missing.length
        ? check(
            'sip',
            'SIP',
            'fail',
            `Not listening on ${missing.join(', ')}.`,
            'Restart telephony (System): ports and TLS changes only take effect then.',
          )
        : check('sip', 'SIP', 'ok', `Listening on ${want.map(([, w]) => w).join(', ')}`),
    );
  }

  const { RTP_PORT_START: a, RTP_PORT_END: b } = d.config;
  const total = Math.floor((b - a) / 2) + 1;
  const busy = await busyRtpPorts(a, b);
  const range = `UDP ${a}–${b}`;
  out.push(
    busy > total / 4
      ? check(
          'rtp',
          'Call audio ports',
          'warn',
          `${range}: ${busy} of ${total} are taken by other programs (or calls).`,
          `Pick a free range with RTP_PORT_START and RTP_PORT_END (in .env, or the api's environment in your stack), restart, and open that range instead. Two ports per call: 200 ports is plenty for a small office.`,
        )
      : check(
          'rtp',
          'Call audio ports',
          'ok',
          `${range}, ${total} usable${busy ? `, ${busy} in use` : ''}`,
        ),
  );

  out.push(
    !s['network.probeUrl']
      ? check(
          'probe',
          'Network test probe',
          'skip',
          'None set, so nothing is tested from outside your network.',
          'Run apps/probe on a machine outside this network (deploy/probe), then put its URL in Settings → Network.',
        )
      : s['network.probeKeyEnc']
        ? check('probe', 'Network test probe', 'ok', `${s['network.probeUrl']}, with its key`)
        : check(
            'probe',
            'Network test probe',
            'warn',
            `${s['network.probeUrl']} has no key: anyone who finds it can use it.`,
            'Settings → Network → Generate key, then set it as PROBE_KEY on the probe and restart it (strongly recommended).',
          ),
  );
  return out;
}

type ProbeResult = { id: string; ok: boolean; detail: string };
/** The probe's reason in brackets, unless it only repeats "no answer". */
const why = (detail: string) => (detail === 'no answer' ? '' : ` (${detail})`);

/** The probe's outside tests; `complete` adds TLS, the browser phone's /ws and audio ports. */
export async function networkTest(
  d: DiagDeps,
  mode: 'quick' | 'complete',
): Promise<NetworkTestDto> {
  const s = await getAllSettings(d.db);
  const probe = s['network.probeUrl'];
  if (!probe) throw new Error('No network test probe set (Settings → Network)');
  const host = d.config.PUBLIC_HOSTNAME;
  const port = s['sip.udpPort'];
  const { RTP_PORT_START: a, RTP_PORT_END: b } = d.config;
  const lan = s['network.lanIp'] ?? 'this server';

  const tests: Record<string, unknown>[] = [
    { id: 'http', kind: 'http', port: 80, path: '/' },
    { id: 'https', kind: 'https', port: 443, path: '/healthz' },
    { id: 'sip-udp', kind: 'sip-udp', port },
    ...(s['sip.tcpEnabled'] ? [{ id: 'sip-tcp', kind: 'sip-tcp', port }] : []),
  ];
  // Audio ports: a few, listened on here for the probe's datagrams.
  const listeners: { port: number; sock: Socket; got: boolean }[] = [];
  if (mode === 'complete') {
    tests.push({ id: 'ws', kind: 'https', port: 443, path: '/ws', websocket: true });
    if (s['sip.tlsEnabled']) tests.push({ id: 'sip-tls', kind: 'sip-tls', port: s['sip.tlsPort'] });
    const even = (p: number) => p - (p % 2);
    const sample = [
      ...new Set([
        even(a + 1),
        even(b),
        even(a + Math.floor((b - a) / 2)),
        even(Math.min(b, a + 2 + Math.floor(Math.random() * Math.max(0, b - a - 2)))),
      ]),
    ];
    const token = randomBytes(8).toString('hex');
    for (const p of sample) {
      const sock = createSocket('udp4');
      const ok = await new Promise<boolean>((r) => {
        sock.once('error', () => r(false));
        sock.bind(p, () => r(true));
      });
      if (!ok) continue; // a call or another program has it: try the others
      const l = { port: p, sock, got: false };
      sock.on('message', (m) => (l.got ||= m.toString().includes(token)));
      listeners.push(l);
      tests.push({ id: `rtp-${p}`, kind: 'udp', port: p, token });
    }
  }

  let ip: string | null = null;
  let results: ProbeResult[] = [];
  let probeError: string | null = null;
  let keyRefused = false;
  const key = s['network.probeKeyEnc'];
  try {
    const r = await (d.fetchProbe ?? fetch)(new URL('/v1/check', probe), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key && { authorization: `Bearer ${decrypt(key)}` }),
      },
      body: JSON.stringify({ host, tests }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await r.json()) as { ip?: string; results?: ProbeResult[]; error?: string };
    keyRefused = r.status === 401;
    if (!r.ok) probeError = body.error ?? `HTTP ${r.status}`;
    else ({ ip = null, results = [] } = body as { ip: string; results: ProbeResult[] });
    // Datagrams sent last arrive just after the answer.
    await new Promise((r) => setTimeout(r, 700));
  } catch (e) {
    probeError = (e as Error).message;
  } finally {
    for (const l of listeners) l.sock.close();
  }
  if (probeError)
    return {
      mode,
      testedIp: null,
      checks: [
        check(
          'probe',
          'Network test probe',
          'fail',
          `${probe} didn't answer: ${probeError}`,
          keyRefused
            ? "The probe's PROBE_KEY isn't this server's key. Settings → Network → Generate key, set it as PROBE_KEY on the probe and restart it."
            : 'Check the probe runs and is reachable from this server, then try again.',
        ),
      ],
    };

  const res = (id: string) => results.find((x) => x.id === id);
  const out: DiagnosticCheck[] = [];
  if (ip && isIPv4(ip) && PRIVATE.check(ip, 'ipv4'))
    out.push(
      check(
        'probe-ip',
        'Tested address',
        'warn',
        `The probe saw ${ip}, a private address: it's inside your network, so these results don't show what the internet sees.`,
        'Run the probe on a machine outside this network.',
      ),
    );
  else if (ip && s['network.publicIp'] && ip !== s['network.publicIp'])
    out.push(
      check(
        'probe-ip',
        'Tested address',
        'warn',
        `The probe saw this server as ${ip}, but the public IP is set to ${s['network.publicIp']} (a VPN, or a changed address?).`,
        `If ${ip} is right: Settings → Network → Public IP, then restart telephony.`,
      ),
    );
  else if (ip) out.push(check('probe-ip', 'Tested address', 'ok', ip));

  const http = res('http');
  if (http)
    out.push(
      http.ok
        ? check('http', 'HTTP (TCP 80)', 'ok', http.detail)
        : check(
            'http',
            'HTTP (TCP 80)',
            'warn',
            `Not reachable${why(http.detail)}. Only needed to get the HTTPS certificate over HTTP (the bundled Caddy, or certbot).`,
            'If you need it: forward TCP 80 to this server on the router, and sudo ufw allow 80/tcp.',
          ),
    );
  const https = res('https');
  if (https) {
    const status = Number(/HTTP (\d{3})/.exec(https.detail)?.[1]);
    out.push(
      !https.ok
        ? check(
            'https',
            'HTTPS (TCP 443)',
            'fail',
            `Not reachable${why(https.detail)}. The web app, the browser phone and phone setup all use it.`,
            `Forward TCP 443 to ${lan} on the router, and sudo ufw allow 443/tcp.`,
          )
        : status !== 200
          ? check(
              'https',
              'HTTPS (TCP 443)',
              'fail',
              `Reachable, but answered ${https.detail.split('; ')[0]} instead of SelfPhoneNG.`,
              "Your reverse proxy can't reach the api: it must send this host name to 127.0.0.1 on the api's port (API_PORT, 8080 by default).",
            )
          : /certificate isn't valid/.test(https.detail)
            ? check(
                'https',
                'HTTPS (TCP 443)',
                'warn',
                https.detail,
                `Get a certificate for ${host}: the bundled Caddy does it by itself; with your own proxy, certbot.`,
              )
            : check('https', 'HTTPS (TCP 443)', 'ok', https.detail),
    );
  }
  const udp = res('sip-udp');
  if (udp)
    out.push(
      udp.ok
        ? check('sip-udp', `SIP (UDP ${port})`, 'ok', `Asterisk answered: ${udp.detail}`)
        : check(
            'sip-udp',
            `SIP (UDP ${port})`,
            'fail',
            `No answer${why(udp.detail)}. Phones away from the office, phone apps on mobile data and the SIP provider's calls all need it.`,
            `Forward UDP ${port} to ${lan} on the router (on both, behind two), sudo ufw allow ${port}/udp, and turn off SIP ALG on the router.`,
          ),
    );
  const tcp = res('sip-tcp');
  if (tcp)
    out.push(
      tcp.ok
        ? check('sip-tcp', `SIP (TCP ${port})`, 'ok', `Asterisk answered: ${tcp.detail}`)
        : check(
            'sip-tcp',
            `SIP (TCP ${port})`,
            'warn',
            `No answer${why(tcp.detail)}. Only phones set to TCP need it.`,
            `Forward TCP ${port} to ${lan} and sudo ufw allow ${port}/tcp, or keep phones on UDP.`,
          ),
    );
  const tls = res('sip-tls');
  if (tls)
    out.push(
      tls.ok
        ? check(
            'sip-tls',
            `SIP over TLS (TCP ${s['sip.tlsPort']})`,
            'ok',
            `Asterisk answered: ${tls.detail}`,
          )
        : check(
            'sip-tls',
            `SIP over TLS (TCP ${s['sip.tlsPort']})`,
            'fail',
            `No answer${why(tls.detail)}.`,
            `Forward TCP ${s['sip.tlsPort']} to ${lan} and sudo ufw allow ${s['sip.tlsPort']}/tcp.`,
          ),
    );
  const ws = res('ws');
  if (ws)
    out.push(
      ws.ok
        ? check('ws', 'Browser phone (/ws)', 'ok', ws.detail)
        : check(
            'ws',
            'Browser phone (/ws)',
            'fail',
            `The WebSocket didn't open${why(ws.detail)}.`,
            'Your reverse proxy must pass WebSocket upgrades on /ws to 127.0.0.1:8088 (see deploy/nginx/selfphoneng.conf.example).',
          ),
    );
  if (mode === 'complete') {
    const got = listeners.filter((l) => l.got);
    const range = `UDP ${a}–${b}`;
    const fix = `Forward ${range} to ${lan} on the router, and sudo ufw allow ${a}:${b}/udp. Without it calls connect but have no sound, or only one way.`;
    out.push(
      !listeners.length
        ? check(
            'rtp',
            `Call audio (${range})`,
            'skip',
            'Every sampled port was in use here: try again.',
          )
        : got.length === listeners.length
          ? check(
              'rtp',
              `Call audio (${range})`,
              'ok',
              `${got.length} of ${listeners.length} sampled ports got through`,
            )
          : check(
              'rtp',
              `Call audio (${range})`,
              got.length ? 'warn' : 'fail',
              `${got.length} of ${listeners.length} sampled ports got through (missing: ${listeners
                .filter((l) => !l.got)
                .map((l) => l.port)
                .join(', ')}).`,
              got.length
                ? `The forward or firewall rule doesn't cover the whole range. ${fix}`
                : fix,
            ),
    );
  }
  return { mode, testedIp: ip, checks: out };
}
