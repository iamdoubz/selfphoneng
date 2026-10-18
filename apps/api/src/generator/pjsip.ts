// SPDX-License-Identifier: AGPL-3.0-or-later
// pjsip_selfphoneng.conf (03 §5) and rtp_selfphoneng.conf (03 §4).
import { CLASS_RANK } from '@selfphoneng/shared';
import { byNumber, type SnapExtension, type SnapTrunk, type Snapshot } from './load.ts';
import * as s from './sanitize.ts';

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
    `set_var = SP_CLASS=${CLASS_RANK[e.outboundClass]}`,
    e.outboundCallerId && `set_var = SP_OUTCID=${s.digits(e.outboundCallerId)}`,
    e.emergencyCallerId && `set_var = SP_E911CID=${s.digits(e.emergencyCallerId)}`,
    `set_var = SP_RECMODE=${e.recordMode}`,
    'set_var = __SP_DIRECTION=internal',
  ];
  const common = [
    `callerid = "${name}" <${num}>`,
    mailbox,
    // The AOR also sends unsolicited MWI; without this, a phone's own SUBSCRIBE gets a 500.
    mailbox && 'mwi_subscribe_replaces_unsolicited = yes',
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
        // Otherwise the From domain is the machine's hostname, and SIP.js drops INVITEs whose host
        // label starts with a digit (e.g. a Docker or VPS hostname). The browser ignores the domain.
        'from_domain = selfphoneng.invalid',
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

/** One trunk (03 §5.3). Sections are named by id so a rename never touches Asterisk objects. */
function trunkSections(t: SnapTrunk, snap: Snapshot): string {
  const id = s.ident(t.id);
  const name = s.name(t.name);
  const on = { tcp: snap.settings['sip.tcpEnabled'], tls: snap.settings['sip.tlsEnabled'] };
  if (t.transport !== 'udp' && !on[t.transport])
    throw new s.SanitizeError(`trunk ${name}: transport ${t.transport} is turned off`);
  const transport = `transport-${t.transport}`;
  const host = s.host(t.serverHost);
  const target = `${host}:${s.digits(String(t.serverPort))}${t.transport === 'udp' ? '' : `;transport=${t.transport}`}`;
  const reg = t.authMode === 'registration';
  const user = t.username ? s.sipUser(t.username) : null;
  if (reg && (!user || !t.password))
    throw new s.SanitizeError(`trunk ${name}: registration needs a username and password`);
  const fromUser = t.fromUser ? s.sipUser(t.fromUser) : user;
  const out = [`; ── trunk "${name}" ──`];
  if (reg)
    out.push(
      section(`trunk-${id}-auth`, [
        'type = auth',
        'auth_type = userpass',
        `username = ${user}`,
        `password = ${s.typedSecret(t.password!)}`,
      ]),
      section(`trunk-${id}-reg`, [
        'type = registration',
        `transport = ${transport}`,
        `outbound_auth = trunk-${id}-auth`,
        `server_uri = sip:${target}`,
        `client_uri = sip:${user}@${target}`,
        `contact_user = ${user}`,
        'retry_interval = 60',
        'forbidden_retry_interval = 600',
        'fatal_retry_interval = 600',
        'max_retries = 10000',
        'expiration = 300',
        'line = yes',
        `endpoint = trunk-${id}`,
      ]),
    );
  out.push(
    section(`trunk-${id}`, ['type = aor', `contact = sip:${target}`, 'qualify_frequency = 60']),
    section(`trunk-${id}`, [
      'type = endpoint',
      `transport = ${transport}`,
      `context = sp-from-trunk-${id}`,
      'disallow = all',
      `allow = ${t.codecs.map(s.codec).join(',')}`,
      reg && `outbound_auth = trunk-${id}-auth`,
      `aors = trunk-${id}`,
      fromUser && `from_user = ${fromUser}`,
      `from_domain = ${t.fromDomain ? s.host(t.fromDomain) : host}`,
      'direct_media = no',
      'rtp_symmetric = yes',
      'force_rport = yes',
      'rewrite_contact = yes',
      'send_rpid = yes', // carries our caller ID to the provider
      'trust_id_inbound = yes',
      'dtmf_mode = rfc4733',
      t.srtp && t.transport === 'tls' && 'media_encryption = sdes',
    ]),
    section(`trunk-${id}-identify`, [
      'type = identify',
      `endpoint = trunk-${id}`,
      `match = ${host}`,
    ]),
  );
  return out[0] + '\n' + out.slice(1).join('\n\n');
}

export function renderPjsip(snap: Snapshot): string {
  const exts = [...snap.extensions].sort(byNumber).map(extensionSections);
  const trunks = snap.trunks
    .filter((t) => t.enabled)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((t) => trunkSections(t, snap));
  return [renderTransports(snap), ...exts, ...trunks].join('\n\n') + '\n';
}

export function renderRtp(snap: Snapshot): string {
  const st = snap.settings;
  const lines = ['icesupport = yes'];
  if (st['network.stunServer']) lines.push(`stunaddr = ${hostPort(st['network.stunServer'])}`);
  if (st['network.lanIp'] && st['network.publicIp'])
    lines.push(
      '',
      '[ice_host_candidates]',
      // Keep the LAN candidate too: browsers on the LAN would otherwise need hairpin NAT.
      `${s.ipv4(st['network.lanIp'])} => ${s.ipv4(st['network.publicIp'])},include_local_address`,
    );
  return lines.join('\n') + '\n';
}
