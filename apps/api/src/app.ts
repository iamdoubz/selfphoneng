// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { sql } from 'drizzle-orm';
import type { Config } from './config.ts';
import type { Db } from './db/client.ts';
import type { Generator } from './generator/index.ts';
import type { AmiClient } from './ami/client.ts';
import { settingsRoutes } from './routes/settings.ts';
import { errorHandler, forbidden, notFound, sendError } from './errors.ts';
import { authRoutes } from './routes/auth.ts';
import { userRoutes } from './routes/users.ts';
import { systemRoutes } from './routes/system.ts';
import { extensionRoutes } from './routes/extensions.ts';
import { trunkRoutes } from './routes/trunks.ts';
import { didRoutes } from './routes/dids.ts';
import { outboundRouteRoutes } from './routes/outbound.ts';
import { liveRoutes } from './live/hub.ts';
import { meRoutes } from './routes/me.ts';
import { soundRoutes } from './routes/sounds.ts';
import { ringGroupRoutes } from './routes/ringgroups.ts';
import { queueRoutes } from './routes/queues.ts';
import { conferenceRoutes } from './routes/conferences.ts';
import { pagingRoutes } from './routes/paging.ts';
import { ivrRoutes } from './routes/ivrs.ts';
import { timeConditionRoutes } from './routes/timeconditions.ts';
import { announcementRoutes } from './routes/announcements.ts';
import { blockedRoutes } from './routes/blocked.ts';
import { callRoutes } from './routes/calls.ts';
import { recordingRoutes } from './routes/recordings.ts';
import { liveCallRoutes } from './routes/livecalls.ts';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    config: Config;
    /** Decorated by the caller (index.ts, tests) before ready(): it needs app.log. */
    generator: Generator;
    /** Decorated by the caller too (tests pass a fake). */
    ami: Pick<AmiClient, 'action' | 'isConnected'>;
  }
}

// Paths the SPA must never swallow (04 §1 step 5).
const NON_SPA = /^\/(api|prov|hooks)(\/|$)/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function buildApp(config: Config, db: Db, publicDir = resolve('public')) {
  const app = Fastify({
    trustProxy: config.TRUST_PROXY ? '127.0.0.1' : false,
    logger: {
      level: config.LOG_LEVEL,
      redact: [
        '*.password',
        '*.secret',
        '*.token',
        '*.pin',
        '*.Secret',
        'req.headers.authorization',
        'req.headers.cookie',
      ],
    },
  });

  app.decorate('db', db);
  app.decorate('config', config);
  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);
  app.register(fastifyCookie);
  app.register(fastifyWebsocket);
  app.setErrorHandler(errorHandler);

  // CSRF (04 §2.2): browsers can't add this header cross-site without CORS, and CORS is off.
  // ponytail: required on every unsafe /api request, not only cookie-authenticated ones; the
  // Bearer-token exemption arrives with API tokens in M11.
  app.addHook('onRequest', async (req, reply) => {
    if (
      req.url.startsWith('/api/') &&
      !SAFE_METHODS.has(req.method) &&
      req.headers['x-requested-with'] !== 'selfphoneng'
    )
      return sendError(reply, forbidden('Missing X-Requested-With header', 'csrf'));
  });

  app.get('/healthz', async (_req, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false, reasons: ['db'] });
    }
  });

  app.register(authRoutes);
  app.register(userRoutes);
  app.register(systemRoutes);
  app.register(extensionRoutes);
  app.register(trunkRoutes);
  app.register(didRoutes);
  app.register(outboundRouteRoutes);
  app.register(settingsRoutes);
  app.register(liveRoutes);
  app.register(meRoutes);
  app.register(soundRoutes);
  app.register(ringGroupRoutes);
  app.register(queueRoutes);
  app.register(conferenceRoutes);
  app.register(pagingRoutes);
  app.register(ivrRoutes);
  app.register(timeConditionRoutes);
  app.register(announcementRoutes);
  app.register(blockedRoutes);
  app.register(callRoutes);
  app.register(recordingRoutes);
  app.register(liveCallRoutes);

  // Always registered: reply.sendFile also streams voicemail audio (with Range) from the spool.
  app.register(fastifyStatic, {
    root: publicDir,
    serve: existsSync(publicDir),
    wildcard: false,
  });
  app.setNotFoundHandler((req, reply) => {
    if (existsSync(publicDir) && req.method === 'GET' && !NON_SPA.test(req.url))
      return reply.sendFile('index.html');
    return sendError(reply, notFound());
  });
  return app;
}
