// SPDX-License-Identifier: AGPL-3.0-or-later
// pjsip_selfphoneng.conf (03 §5) and rtp_selfphoneng.conf (03 §4).
import { byNumber, type SnapExtension, type Snapshot } from './load.ts';
import * as s from './sanitize.ts';

const CLASS_NUMBER = { internal: 0, local: 1, national: 2, international: 3 } as const;

const section = (title: string, lines: (string | false | null | undefined)[]) =>
  [`[${title}]`, ...lines.filter((l): l is string => typeof l === 'string')].join('\n');

/** "stun.example.org:3478" → sanitized host[:port]. */
function hostPort(v: string): string {
  const [h, p, ...rest] = v.split(':');
  if (rest.length) throw new s.SanitizeError(`host:port: invalid value ${JSON.stringify(v)}`);
  return p === undefined ? s.host(h!) : `${s.host(h!)}:${s.digits(p)}`;
}

function natLines(snap: Snapshot): string[] {
  const ip = snap.settings['network.publicIp'];
  if (!ip) return [];
  return [
    `external_media_address = ${s.ipv4(ip)}`,
    `external_signaling_address = ${s.ipv4(ip)}`,
    ...snap.settings['network.localNets'].map((n) => `local_net = ${s.cidr(n)}`),
  ];
}

/** [global], [system] and the transports: hashed to detect changes that need a restart. */
export function renderTransports(snap: Snapshot): string {
  const st = snap.settings;
  const port = s.digits(String(st['sip.udpPort']));
  const nat = natLines(snap);
  return [
    section('global', [
      'type = global',
      'user_agent = SelfPhoneNG',
      'endpoint_identifier_order = ip,username,anonymous',
      'keep_alive_interval = 90',
      'max_initial_qualify_time = 4',
    ]),
    section('system', ['type = system', 'timer_t1 = 500', 'timer_b = 32000']),
    section('transport-udp', [
      'type = transport',
      'protocol = udp',
      `bind = 0.0.0.0:${port}`,
      ...nat,
    ]),
    st['sip.tcpEnabled'] &&
      section('transport-tcp', [
        'type = transport',
        'protocol = tcp',
        `bind = 0.0.0.0:${port}`,
        ...nat,
      ]),
    st['sip.tlsEnabled'] &&
      section('transport-tls', [
        'type = transport',
        'protocol = tls',
        `bind = 0.0.0.0:${s.digits(String(st['sip.tlsPort']))}`,
        'cert_file = /var/lib/selfphoneng/tls/fullchain.pem',
        'priv_key_file = /var/lib/selfphoneng/tls/privkey.pem',
        'method = tlsv1_2',
        ...nat,
      ]),
    // The bind address is ignored: browsers arrive through Asterisk's HTTP server (01 §3.5).
    section('transport-ws', ['type = transport', 'protocol = ws', 'bind = 0.0.0.0']),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function extensionSections(e: SnapExtension): string {
  const num = s.digits(e.number);
  const name = s.name(e.name) || num;
  const groups = e.pickupGroup ? s.ident(e.pickupGroup) : null;
  const mailbox = e.voicemailEnabled ? `mailboxes = ${num}@default` : null;
  const vars = [
    `set_var = SP_EXT=${num}`,
    `set_var = SP_CLASS=${CLASS_NUMBER[e.outboundClass]}`,
    e.outboundCallerId && `set_var = SP_OUTCID=${s.digits(e.outboundCallerId)}`,
    e.emergencyCallerId && `set_var = SP_E911CID=${s.digits(e.emergencyCallerId)}`,
    `set_var = SP_RECMODE=${e.recordMode}`,
    'set_var = __SP_DIRECTION=internal',
  ];
  const common = [
    `callerid = "${name}" <${num}>`,
    mailbox,
    'dtmf_mode = rfc4733',
    'allow_subscribe = yes',
    groups && `named_call_group = ${groups}`,
    groups && `named_pickup_group = ${groups}`,
    `language = ${s.ident(e.language)}`,
    `moh_suggest = ${s.ident(e.mohClass)}`,
    'tone_zone = us',
    ...vars,
  ];
  const password = s.secret(e.sipPassword);
  const out = [
    `; ── extension ${num} (${name}) ──
` +
      section(num, [
        'type = endpoint',
        'context = sp-from-ext',
        'disallow = all',
        'allow = g722,ulaw,alaw',
        `auth = ${num}-auth`,
        `aors = ${num}`,
        'direct_media = no',
        'rtp_symmetric = yes',
        'force_rport = yes',
        'rewrite_contact = yes',
        'send_pai = yes',
        ...common,
      ]),
    section(`${num}-auth`, [
      'type = auth',
      'auth_type = userpass',
      `username = ${num}`,
      `password = ${password}`,
    ]),
    section(num, [
      'type = aor',
      `max_contacts = ${s.digits(String(e.maxContacts))}`,
      'remove_existing = yes',
      'qualify_frequency = 30',
      mailbox,
    ]),
  ];
  if (e.webrtcEnabled)
    out.push(
      section(`${num}-web`, [
        'type = endpoint',
        'context = sp-from-ext',
        'webrtc = yes', // ICE, AVPF, DTLS-SRTP, rtcp-mux
        'disallow = all',
        'allow = g722,ulaw', // no opus: no open source transcoder in Asterisk (AGENTS rule 4)
        `auth = ${num}-web-auth`,
        `aors = ${num}-web`,
        ...common,
      ]),
      section(`${num}-web-auth`, [
        'type = auth',
        'auth_type = userpass',
        `username = ${num}-web`,
        `password = ${password}`,
      ]),
      section(`${num}-web`, [
        'type = aor',
        'max_contacts = 3',
        'remove_existing = yes',
        'qualify_frequency = 0', // browsers don't answer OPTIONS reliably
      ]),
    );
  return out.join('\n\n');
}

export function renderPjsip(snap: Snapshot): string {
  const exts = [...snap.extensions].sort(byNumber).map(extensionSections);
  return [renderTransports(snap), ...exts].join('\n\n') + '\n';
}

export function renderRtp(snap: Snapshot): string {
  const st = snap.settings;
  const lines = ['icesupport = yes'];
  if (st['network.stunServer']) lines.push(`stunaddr = ${hostPort(st['network.stunServer'])}`);
  if (st['network.lanIp'] && st['network.publicIp'])
    lines.push(
      '',
      '[ice_host_candidates]',
      `${s.ipv4(st['network.lanIp'])} => ${s.ipv4(st['network.publicIp'])}`,
    );
  return lines.join('\n') + '\n';
}
