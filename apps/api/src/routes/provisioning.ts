// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /prov/... (07 §2): phones fetch their config with HTTP Basic auth (user = MAC, password =
// the device's provisioning password). No session. Unknown MAC or bad auth → 401, alike; wrong
// credentials are logged with the IP and count toward an IP block (provisioning/limiter.ts).
import { timingSafeEqual } from 'node:crypto';
import { BlockList, isIPv4 } from 'node:net';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { decrypt } from '../crypto/secrets.ts';
import { devices, extensions } from '../db/schema.ts';
import { linphoneXml, verifyLinphoneToken } from '../provisioning/linphone.ts';
import type { PhoneVendor } from '@selfphoneng/shared';
import {
  loadContext,
  loadPhonebook,
  type PhonebookEntry,
  type ProvisionContext,
} from '../provisioning/context.ts';
import { allowProvRequest, recordProvFailure } from '../provisioning/limiter.ts';
import { grandstream, grandstreamPhonebook } from '../provisioning/templates/grandstream.ts';
import { polycom, polycomMaster } from '../provisioning/templates/polycom.ts';
import { snom } from '../provisioning/templates/snom.ts';
import { yealink, yealinkCommon, yealinkPhonebook } from '../provisioning/templates/yealink.ts';
import { getSetting } from '../services/settings.ts';
import { NO_LIMIT } from '../auth/guards.ts';

type Render = (c: ProvisionContext, book: () => Promise<PhonebookEntry[]>) => Promise<string>;
const TEXT = 'text/plain';
const XML = 'application/xml';
const config =
  (f: (c: ProvisionContext) => string): Render =>
  async (c) =>
    f(c);
const phonebook =
  (f: (entries: PhonebookEntry[]) => string): Render =>
  async (_c, book) =>
    f(await book());

/**
 * File name → what each make gets for it. A name no make here uses is a plain 404 (phones ask
 * for files we don't serve); a name asked by a phone of another make is a failure (07 §2).
 */
const FILES: { re: RegExp; by: Partial<Record<PhoneVendor, [type: string, render: Render]>> }[] = [
  // Yealink's config and Polycom's master file share the name.
  {
    re: /^([0-9a-f]{12})\.cfg$/,
    by: { yealink: [TEXT, config(yealink)], polycom: [XML, config(polycomMaster)] },
  },
  { re: /^phone-([0-9a-f]{12})\.cfg$/, by: { polycom: [XML, config(polycom)] } },
  { re: /^cfg([0-9a-f]{12})\.xml$/, by: { grandstream: [XML, config(grandstream)] } },
  // snom<model>-<MAC>.htm (the model-wide snom<model>.htm is a 404: nothing in it).
  { re: /^snom[a-z0-9]*-([0-9a-f]{12})\.htm$/, by: { snom: [XML, config(snom)] } },
  // Yealink: phonebook/<mac>.xml; Grandstream appends /phonebook.xml to the path it's given.
  {
    re: /^phonebook\/([0-9a-f]{12})(?:\.xml|\/phonebook\.xml)$/,
    by: {
      yealink: [XML, phonebook(yealinkPhonebook)],
      grandstream: [XML, phonebook(grandstreamPhonebook)],
    },
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

  const deny = (reply: FastifyReply, code: number, text: string) =>
    reply.code(code).header('Cache-Control', 'no-store').type('text/plain').send(text);

  app.get('/prov/*', { config: NO_LIMIT }, async (req, reply) => {
    if (!(await getSetting(db, 'provisioning.enabled'))) return deny(reply, 404, 'Not found');
    const local = await isLocal(req.ip);
    if ((await getSetting(db, 'provisioning.lanOnly')) && !local)
      return deny(reply, 403, 'Forbidden');
    if (!allowProvRequest(req.ip, local)) return deny(reply, 429, 'Too many requests');

    const raw = (req.params as { '*': string })['*'];
    // Linphone (07 §5): the token is the credential (case matters), no Basic auth.
    const lin = /^linphone\/([A-Za-z0-9_-]{20,200})\.xml$/.exec(raw);
    if (lin) {
      const extId = verifyLinphoneToken(app.config.APP_SECRET, lin[1]!);
      const [e] = extId ? await db.select().from(extensions).where(eq(extensions.id, extId)) : [];
      if (!e) {
        recordProvFailure(req.ip);
        req.log.warn({ ip: req.ip }, 'provisioning: bad or expired Linphone token');
        return deny(reply, 404, 'Not found');
      }
      req.log.info({ ip: req.ip, ext: e.number }, 'provisioning: Linphone config served');
      return reply
        .header('Cache-Control', 'no-store')
        .type('application/xml')
        .send(
          linphoneXml({
            host: app.config.PUBLIC_HOSTNAME,
            sipPort: await getSetting(db, 'sip.udpPort'),
            transport: 'udp',
            number: e.number,
            name: e.name,
            sipPassword: decrypt(e.sipPasswordEnc),
          }),
        );
    }
    const file = raw.toLowerCase();
    if (YEALINK_COMMON.test(file))
      return reply.header('Cache-Control', 'no-store').type('text/plain').send(yealinkCommon());
    const kind = FILES.map((f) => ({ f, m: f.re.exec(file) })).find((x) => x.m);
    if (!kind) return deny(reply, 404, 'Not found');
    const mac = kind.m![1]!;

    const loaded = await loadContext(db, app.config, mac);
    // Nothing for a phone set up by hand, or of a make that doesn't use this file name.
    const served = loaded ? kind.f.by[loaded.ctx.vendor] : undefined;
    const found = loaded && served ? loaded : null;
    const auth = basicAuth(req);
    const ok =
      found !== null &&
      auth !== null &&
      auth.user.toLowerCase() === mac &&
      same(auth.pass, found.ctx.provPassword);
    if (!ok) {
      // An unknown MAC gets the same 401 as a known one, so the answers don't tell which MACs
      // exist (08 §6). A phone asks without credentials first and retries: not a failure.
      if (auth) {
        recordProvFailure(req.ip);
        req.log.warn(
          { ip: req.ip, mac },
          found ? 'provisioning: wrong credentials' : 'provisioning: unknown MAC',
        );
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
    const [type, render] = served!;
    return reply
      .header('Cache-Control', 'no-store')
      .type(type)
      .send(await render(found.ctx, () => loadPhonebook(db, found.ctx.ownerUserId)));
  });
}
