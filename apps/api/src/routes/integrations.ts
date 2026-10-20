// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/webhooks (04 §9) and /api/api-tokens (04 §2.3). Admin only.
import { randomBytes } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ApiTokenInputSchema,
  WebhookInputSchema,
  type ApiTokenDto,
  type ListResponse,
  type WebhookDeliveryDto,
  type WebhookDto,
  type WebhookEvent,
} from '@selfphoneng/shared';
import { requireAdmin } from '../auth/guards.ts';
import { generateToken, hashToken } from '../auth/tokens.ts';
import { decrypt, encrypt } from '../crypto/secrets.ts';
import { apiTokens, users, webhookDeliveries, webhooks } from '../db/schema.ts';
import { forbidden, notFound } from '../errors.ts';
import { audit } from '../services/audit.ts';
import { getSetting } from '../services/settings.ts';
import { postSigned } from '../services/webhooks.ts';

type Hook = typeof webhooks.$inferSelect;
const toDto = (h: Hook): WebhookDto => ({
  id: h.id,
  url: h.url,
  events: h.events as WebhookEvent[],
  enabled: h.enabled,
  secret: decrypt(h.secretEnc),
  createdAt: h.createdAt.toISOString(),
});
const IdParams = z.object({ id: z.uuid() });

export async function integrationRoutes(app: FastifyInstance) {
  const { db } = app;
  app.addHook('preHandler', requireAdmin);
  const act = (req: FastifyRequest) => ({ actorUserId: req.user!.id, actorIp: req.ip });
  async function getHook(id: string) {
    const [h] = await db.select().from(webhooks).where(eq(webhooks.id, id));
    if (!h) throw notFound('Webhook not found');
    return h;
  }

  app.get('/api/webhooks', async (): Promise<ListResponse<WebhookDto>> => ({
    items: (await db.select().from(webhooks).orderBy(webhooks.createdAt)).map(toDto),
    nextCursor: null,
  }));

  app.post('/api/webhooks', async (req, reply) => {
    const body = WebhookInputSchema.parse(req.body);
    const [h] = (await db
      .insert(webhooks)
      .values({ ...body, secretEnc: encrypt(randomBytes(32).toString('hex')) })
      .returning()) as [Hook];
    await audit(db, {
      ...act(req),
      action: 'create',
      entityType: 'webhook',
      entityId: h.id,
      summary: `Added webhook ${h.url}`,
      diff: { after: body },
    });
    return reply.code(201).send(toDto(h));
  });

  app.patch('/api/webhooks/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const before = await getHook(id);
    const body = WebhookInputSchema.partial().parse(req.body);
    const [h] = (await db
      .update(webhooks)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(webhooks.id, id))
      .returning()) as [Hook];
    await audit(db, {
      ...act(req),
      action: 'update',
      entityType: 'webhook',
      entityId: id,
      summary: `Changed webhook ${h.url}`,
      diff: {
        before: { url: before.url, events: before.events, enabled: before.enabled },
        after: body,
      },
    });
    return toDto(h);
  });

  app.delete('/api/webhooks/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const h = await getHook(id);
    await db.delete(webhooks).where(eq(webhooks.id, id));
    await audit(db, {
      ...act(req),
      action: 'delete',
      entityType: 'webhook',
      entityId: id,
      summary: `Removed webhook ${h.url}`,
    });
    return { ok: true };
  });

  /** Sends a `webhook.test` event now, not queued: the answer shows right away. */
  app.post('/api/webhooks/:id/test', async (req) => {
    const h = await getHook(IdParams.parse(req.params).id);
    const body = JSON.stringify({
      id: crypto.randomUUID(),
      event: 'webhook.test',
      createdAt: new Date().toISOString(),
      data: { message: 'Test from SelfPhoneNG' },
    });
    try {
      const status = await postSigned(
        h.url,
        'webhook.test',
        body,
        decrypt(h.secretEnc),
        await getSetting(db, 'webhooks.allowPrivate'),
      );
      return { ok: status >= 200 && status < 300, status };
    } catch (e) {
      return { ok: false, status: null, error: (e as Error).message };
    }
  });

  app.get(
    '/api/webhooks/:id/deliveries',
    async (req): Promise<ListResponse<WebhookDeliveryDto>> => {
      const h = await getHook(IdParams.parse(req.params).id);
      const rows = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.webhookId, h.id))
        .orderBy(desc(webhookDeliveries.id))
        .limit(50);
      return {
        items: rows.map((d) => ({
          id: d.id,
          event: d.event,
          status: d.status as WebhookDeliveryDto['status'],
          attempt: d.attempt,
          responseCode: d.responseCode,
          createdAt: d.createdAt.toISOString(),
          nextAttemptAt: d.nextAttemptAt?.toISOString() ?? null,
        })),
        nextCursor: null,
      };
    },
  );

  // A token can't make or revoke tokens: a leaked one shouldn't be able to dig in deeper.
  const noToken = (req: FastifyRequest) => {
    if (req.apiTokenId) throw forbidden('Manage API tokens from the web page');
  };

  app.get('/api/api-tokens', async (req): Promise<ListResponse<ApiTokenDto>> => {
    noToken(req);
    const rows = await db
      .select({ t: apiTokens, by: users.email })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.createdBy))
      .where(isNull(apiTokens.revokedAt))
      .orderBy(apiTokens.createdAt);
    return {
      items: rows.map(({ t, by }) => ({
        id: t.id,
        name: t.name,
        tokenPrefix: t.tokenPrefix,
        createdBy: by,
        createdAt: t.createdAt.toISOString(),
        lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
      })),
      nextCursor: null,
    };
  });

  /** The only time the token is shown. */
  app.post('/api/api-tokens', async (req, reply) => {
    noToken(req);
    const { name } = ApiTokenInputSchema.parse(req.body);
    const token = generateToken();
    const [t] = await db
      .insert(apiTokens)
      .values({
        name,
        tokenPrefix: token.slice(0, 7),
        tokenHash: hashToken(token),
        createdBy: req.user!.id,
      })
      .returning();
    await audit(db, {
      ...act(req),
      action: 'create',
      entityType: 'api_token',
      entityId: t!.id,
      summary: `Created API token ${name}`,
    });
    return reply.code(201).send({ id: t!.id, name, token });
  });

  app.delete('/api/api-tokens/:id', async (req) => {
    noToken(req);
    const { id } = IdParams.parse(req.params);
    const [t] = await db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt)))
      .returning();
    if (!t) throw notFound('Token not found');
    await audit(db, {
      ...act(req),
      action: 'delete',
      entityType: 'api_token',
      entityId: id,
      summary: `Revoked API token ${t.name}`,
    });
    return { ok: true };
  });
}
