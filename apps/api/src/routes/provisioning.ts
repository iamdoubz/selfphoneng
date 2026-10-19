// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /prov/... (07 §2): phones fetch their config with HTTP Basic auth (user = MAC, password =
// the device's provisioning password). No session. Unknown MAC → 404, bad auth → 401; both are
// logged with the IP and count toward an IP block (provisioning/limiter.ts).
import { timingSafeEqual } from 'node:crypto';
import { BlockList, isIPv4 } from 'node:net';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { devices } from '../db/schema.ts';
import { loadContext, loadPhonebook, type ProvisionContext } from '../provisioning/context.ts';
import { allowProvRequest, recordProvFailure } from '../provisioning/limiter.ts';
import { grandstream, grandstreamPhonebook } from '../provisioning/templates/grandstream.ts';
import { yealink, yealinkCommon, yealinkPhonebook } from '../provisioning/templates/yealink.ts';
import { getSetting } from '../services/settings.ts';

/** File name → what it is. Anything else is a plain 404 (phones ask for files we don't serve). */
const FILES: {
  re: RegExp;
  /** null: the phonebook, in the device's own vendor's format. */
  vendor: ProvisionContext['vendor'] | null;
  type: string;
}[] = [
  { re: /^([0-9a-f]{12})\.cfg$/, vendor: 'yealink', type: 'text/plain' },
  { re: /^cfg([0-9a-f]{12})\.xml$/, vendor: 'grandstream', type: 'application/xml' },
  // Yealink: phonebook/<mac>.xml; Grandstream appends /phonebook.xml to the path it's given.
  {
    re: /^phonebook\/([0-9a-f]{12})(?:\.xml|\/phonebook\.xml)$/,
    vendor: null,
    type: 'application/xml',
  },
];
const YEALINK_COMMON = /^y0{10}[0-9a-f]{2}\.cfg$/;

/** The Basic auth credentials, or null when there are none. */
function basicAuth(req: FastifyRequest): { user: string; pass: string } | null {
  const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(req.headers.authorization ?? '');
  if (!m) return null;
  const s = Buffer.from(m[1]!, 'base64').toString('utf8');
  const i = s.indexOf(':');
  return i < 0 ? null : { user: s.slice(0, i), pass: s.slice(i + 1) };
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function provisioningRoutes(app: FastifyInstance) {
  const { db } = app;
  const ipv4 = (ip: string) => ip.replace(/^::ffff:/, '');

  async function isLocal(ip: string) {
    const v4 = ipv4(ip);
    if (!isIPv4(v4)) return false;
    const nets = new BlockList();
    for (const n of await getSetting(db, 'network.localNets')) {
      const [addr, bits] = n.split('/');
      nets.addSubnet(addr!, Number(bits), 'ipv4');
    }
    return nets.check(v4, 'ipv4');
  }

  /** The config, or (phonebook) the directory in the phone's vendor's format. */
  async function render(c: ProvisionContext, phonebook = false): Promise<string> {
    if (!phonebook) return c.vendor === 'yealink' ? yealink(c) : grandstream(c);
    const entries = await loadPhonebook(db);
    return c.vendor === 'yealink' ? yealinkPhonebook(entries) : grandstreamPhonebook(entries);
  }

  const deny = (reply: FastifyReply, code: number, text: string) =>
    reply.code(code).header('Cache-Control', 'no-store').type('text/plain').send(text);

  app.get('/prov/*', async (req, reply) => {
    if (!(await getSetting(db, 'provisioning.enabled'))) return deny(reply, 404, 'Not found');
    const local = await isLocal(req.ip);
    if ((await getSetting(db, 'provisioning.lanOnly')) && !local)
      return deny(reply, 403, 'Forbidden');
    if (!allowProvRequest(req.ip, local)) return deny(reply, 429, 'Too many requests');

    const file = (req.params as { '*': string })['*'].toLowerCase();
    if (YEALINK_COMMON.test(file))
      return reply.header('Cache-Control', 'no-store').type('text/plain').send(yealinkCommon());
    const kind = FILES.map((f) => ({ f, m: f.re.exec(file) })).find((x) => x.m);
    if (!kind) return deny(reply, 404, 'Not found');
    const mac = kind.m![1]!;

    const found = await loadContext(db, app.config, mac);
    if (
      !found ||
      found.ctx.vendor === 'generic' ||
      (kind.f.vendor && found.ctx.vendor !== kind.f.vendor)
    ) {
      recordProvFailure(req.ip);
      req.log.warn({ ip: req.ip, mac }, 'provisioning: unknown MAC');
      return deny(reply, 404, 'Not found');
    }
    const auth = basicAuth(req);
    const ok =
      auth !== null && auth.user.toLowerCase() === mac && same(auth.pass, found.ctx.provPassword);
    if (!ok) {
      // A phone asks without credentials first and retries after the 401: not a failure.
      if (auth) {
        recordProvFailure(req.ip);
        req.log.warn({ ip: req.ip, mac }, 'provisioning: wrong credentials');
      }
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Basic realm="selfphoneng"')
        .header('Cache-Control', 'no-store')
        .type('text/plain')
        .send('Unauthorized');
    }
    await db
      .update(devices)
      .set({ lastProvisionedAt: sql`now()`, lastProvisionedIp: ipv4(req.ip) })
      .where(eq(devices.id, found.id));
    req.log.info({ ip: req.ip, mac }, 'provisioning: served');
    return reply
      .header('Cache-Control', 'no-store')
      .type(kind.f.type)
      .send(await render(found.ctx, kind.f.vendor === null));
  });
}
