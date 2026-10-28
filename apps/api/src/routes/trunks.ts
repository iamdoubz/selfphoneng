// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/trunks (04 §7.3, 06 §2). Admin only. Passwords are write-only.
import { lookup } from 'node:dns/promises';
import { isIPv4 } from 'node:net';
import { arrayContains, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ImportDidsSchema,
  TrunkCreateSchema,
  formatNumber,
  TrunkUpdateSchema,
  type ListResponse,
  type TrunkDto,
  type TrunkTestResult,
  type VoipmsDidDto,
} from '@selfphoneng/shared';
import type { Db } from '../db/client.ts';
import { dids, outboundRoutes, trunks } from '../db/schema.ts';
import { badRequest, conflict, HttpError, notFound } from '../errors.ts';
import { SLOW, requireAdmin } from '../auth/guards.ts';
import { decrypt, encrypt } from '../crypto/secrets.ts';
import {
  getDids,
  getServers,
  VoipmsError,
  type VoipmsCreds,
} from '../integrations/voipms/client.ts';
import { audit } from '../services/audit.ts';
import { getSetting, setSetting } from '../services/settings.ts';
import { createDefaultRoutes } from '../services/outbound.ts';

type TrunkRow = typeof trunks.$inferSelect;

const toDto = (t: TrunkRow): TrunkDto => ({
  id: t.id,
  name: t.name,
  provider: t.provider,
  enabled: t.enabled,
  serverHost: t.serverHost,
  serverPort: t.serverPort,
  transport: t.transport,
  authMode: t.authMode,
  username: t.username,
  fromUser: t.fromUser,
  fromDomain: t.fromDomain,
  codecs: t.codecs as TrunkDto['codecs'],
  srtp: t.srtp,
  maxChannels: t.maxChannels,
  voipmsApiUsername: t.voipmsApiUsername,
  hasPassword: t.passwordEnc !== null,
  hasApiPassword: t.voipmsApiPasswordEnc !== null,
  createdAt: t.createdAt.toISOString(),
});

const IdParams = z.object({ id: z.uuid() });

async function getTrunk(db: Db, id: string): Promise<TrunkRow> {
  const [t] = await db.select().from(trunks).where(eq(trunks.id, id));
  if (!t) throw notFound('Trunk not found');
  return t;
}

/** Things the generator can't render or Asterisk can't load: refuse them up front. */
async function checkUsable(db: Db, t: Pick<TrunkRow, 'serverHost' | 'transport'>) {
  if (t.transport === 'tcp' && !(await getSetting(db, 'sip.tcpEnabled')))
    throw badRequest('Turn on SIP over TCP in Settings → SIP first');
  if (t.transport === 'tls' && !(await getSetting(db, 'sip.tlsEnabled')))
    throw badRequest('Turn on SIP over TLS in Settings → SIP first');
  // Asterisk refuses to load a trunk whose server name doesn't resolve (identify fails).
  if (!isIPv4(t.serverHost))
    await lookup(t.serverHost, { family: 4 }).catch(() => {
      throw badRequest(`Can't find the server ${t.serverHost}. Check the spelling.`);
    });
}

const isUniqueViolation = (e: unknown) =>
  ((e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code) === '23505';

export async function trunkRoutes(app: FastifyInstance) {
  const { db } = app;
  app.addHook('preHandler', requireAdmin);

  app.get('/api/trunks', async (): Promise<ListResponse<TrunkDto>> => {
    const rows = await db.select().from(trunks).orderBy(asc(trunks.name));
    return { items: rows.map(toDto), nextCursor: null };
  });

  app.get('/api/trunks/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    return toDto(await getTrunk(db, id));
  });

  app.post('/api/trunks', async (req, reply) => {
    const { password, voipmsApiPassword, ...body } = TrunkCreateSchema.parse(req.body);
    const values = {
      ...body,
      voipmsApiUsername: body.voipmsApiUsername || null,
      passwordEnc: password ? encrypt(password) : null,
      voipmsApiPasswordEnc: voipmsApiPassword ? encrypt(voipmsApiPassword) : null,
    };
    await checkUsable(db, { serverHost: body.serverHost, transport: body.transport ?? 'udp' });
    let created: TrunkRow;
    try {
      [created] = (await db.insert(trunks).values(values).returning()) as [TrunkRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict(`A trunk named ${body.name} already exists`);
      throw e;
    }
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'create',
      entityType: 'trunk',
      entityId: created.id,
      summary: `Created trunk ${created.name}`,
      diff: { after: toDto(created) },
    });
    await createDefaultRoutes(db, created.id); // only when there are no routes yet (06 §4)
    app.generator.requestApply('api-change');
    return reply.code(201).send(toDto(created));
  });

  app.patch('/api/trunks/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { password, voipmsApiPassword, ...body } = TrunkUpdateSchema.parse(req.body);
    const before = await getTrunk(db, id);
    const merged = { ...before, ...body };
    if (merged.srtp && merged.transport !== 'tls') throw badRequest('SRTP needs the TLS transport');
    if (
      merged.authMode === 'registration' &&
      (!merged.username || !(password || before.passwordEnc))
    )
      throw badRequest('Registration needs a username and password');
    if (body.serverHost !== undefined || body.transport !== undefined)
      await checkUsable(db, merged);
    const set = {
      ...body,
      ...(password ? { passwordEnc: encrypt(password) } : {}),
      // An empty API password clears it.
      ...(voipmsApiPassword !== undefined
        ? { voipmsApiPasswordEnc: voipmsApiPassword ? encrypt(voipmsApiPassword) : null }
        : {}),
    };
    let after: TrunkRow;
    try {
      [after] = (await db.update(trunks).set(set).where(eq(trunks.id, id)).returning()) as [
        TrunkRow,
      ];
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict(`A trunk named ${body.name} already exists`);
      throw e;
    }
    const b = toDto(before);
    const a = toDto(after);
    const changed = (Object.keys(a) as (keyof TrunkDto)[]).filter(
      (k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]),
    );
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'update',
      entityType: 'trunk',
      entityId: id,
      summary: `Updated trunk ${after.name}${password ? ' (password changed)' : ''}${changed.length ? ` (${changed.join(', ')})` : ''}`,
      diff: {
        before: Object.fromEntries(changed.map((k) => [k, b[k]])),
        after: Object.fromEntries(changed.map((k) => [k, a[k]])),
      },
    });
    app.generator.requestApply('api-change');
    return a;
  });

  app.delete('/api/trunks/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const t = await getTrunk(db, id);
    const usedBy = [
      ...(await db.select({ n: dids.number }).from(dids).where(eq(dids.trunkId, id))).map(
        (r) => `number ${formatNumber(r.n)}`,
      ),
      ...(
        await db
          .select({ n: outboundRoutes.name })
          .from(outboundRoutes)
          .where(arrayContains(outboundRoutes.trunkIds, [id]))
      ).map((r) => `outbound rule "${r.n}"`),
    ];
    if (usedBy.length)
      throw conflict(`${t.name} is still used by ${usedBy.join(', ')}`, { usedBy });
    await db.delete(trunks).where(eq(trunks.id, id));
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'delete',
      entityType: 'trunk',
      entityId: id,
      summary: `Deleted trunk ${t.name}`,
      diff: { before: toDto(t) },
    });
    app.generator.requestApply('api-change');
    return { ok: true };
  });

  app.post('/api/trunks/:id/test', { config: SLOW }, async (req): Promise<TrunkTestResult> => {
    const { id } = IdParams.parse(req.params);
    const t = await getTrunk(db, id);
    if (!t.enabled) throw badRequest('Turn the trunk on first');
    if (!app.live.amiConnected)
      throw new HttpError(503, 'unavailable', 'Asterisk is not connected');
    const { live, rttMs } = await app.live.testTrunk(id);
    const reg = t.authMode === 'registration';
    const detail =
      reg && live.registration === 'registered'
        ? `Registered with ${t.serverHost}`
        : reg && live.registration === 'rejected'
          ? `${t.serverHost} rejected the username or password`
          : !live.reachable
            ? `${t.serverHost} doesn't answer. Check the server name and that this server can reach it on port ${t.serverPort}.`
            : reg
              ? `${t.serverHost} answers but the registration hasn't completed yet. Try again in a minute.`
              : `${t.serverHost} answers (IP authentication: no registration)`;
    return { registration: reg ? live.registration : 'unknown', rttMs, detail };
  });

  /** The trunk's voip.ms API login, or 400 when it has none. */
  function apiCreds(t: TrunkRow): VoipmsCreds {
    if (t.provider !== 'voipms' || !t.voipmsApiUsername || !t.voipmsApiPasswordEnc)
      throw badRequest('Add the voip.ms API username and password to this trunk first');
    return { username: t.voipmsApiUsername, password: decrypt(t.voipmsApiPasswordEnc) };
  }
  /** voip.ms errors → 502 with a message for the admin (never the request URL). */
  async function voipms<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof VoipmsError) throw new HttpError(502, 'provider_error', e.message);
      throw e;
    }
  }
  const apiUrl = app.config.VOIPMS_API_URL;

  /** POP servers for the form's server list (06 §2). */
  app.get('/api/trunks/:id/voipms-servers', async (req) => {
    const t = await getTrunk(db, IdParams.parse(req.params).id);
    return { servers: await voipms(() => getServers(apiUrl, apiCreds(t))) };
  });

  /** The account's numbers, marked when already added (06 §7). */
  app.get('/api/trunks/:id/import-dids', async (req): Promise<ListResponse<VoipmsDidDto>> => {
    const t = await getTrunk(db, IdParams.parse(req.params).id);
    const remote = await voipms(() => getDids(apiUrl, apiCreds(t)));
    const have = new Set((await db.select({ n: dids.number }).from(dids)).map((d) => d.n));
    return {
      items: remote.map((d) => ({ ...d, added: have.has(d.number) })),
      nextCursor: null,
    };
  });

  /** Adds the picked numbers on this trunk, not routed yet (destination hangup). */
  app.post('/api/trunks/:id/import-dids', async (req) => {
    const t = await getTrunk(db, IdParams.parse(req.params).id);
    const { numbers } = ImportDidsSchema.parse(req.body);
    // Only numbers that really are on the account (and not added yet).
    const remote = new Map(
      (await voipms(() => getDids(apiUrl, apiCreds(t)))).map((d) => [d.number, d]),
    );
    const have = new Set((await db.select({ n: dids.number }).from(dids)).map((d) => d.n));
    const picked = [...new Set(numbers)].filter((n) => remote.has(n) && !have.has(n));
    if (!picked.length) throw badRequest('None of those numbers can be added');
    const rows = await db
      .insert(dids)
      .values(
        picked.map((n) => ({
          number: n,
          trunkId: t.id,
          label: remote.get(n)!.description || null,
          destination: { type: 'hangup' as const },
        })),
      )
      .onConflictDoNothing()
      .returning({ id: dids.id, number: dids.number });
    if (rows[0] && (await getSetting(db, 'routing.defaultCallerIdDidId')) === null)
      await setSetting(db, 'routing.defaultCallerIdDidId', rows[0].id);
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'create',
      entityType: 'did',
      entityId: t.id,
      summary: `Imported ${rows.length} number(s) from voip.ms: ${rows.map((r) => formatNumber(r.number)).join(', ')}`,
    });
    app.generator.requestApply('api-change');
    return { added: rows.length };
  });
}
