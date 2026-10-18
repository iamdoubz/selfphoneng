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
import { errorHandler, forbidden, notFound, sendError } from './errors.ts';
import { authRoutes } from './routes/auth.ts';
import { userRoutes } from './routes/users.ts';
import { systemRoutes } from './routes/system.ts';
import { extensionRoutes } from './routes/extensions.ts';
import { trunkRoutes } from './routes/trunks.ts';
import { didRoutes } from './routes/dids.ts';
import { liveRoutes } from './live/hub.ts';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    config: Config;
    /** Decorated by the caller (index.ts, tests) before ready(): it needs app.log. */
    generator: Generator;
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
  app.register(liveRoutes);

  if (existsSync(publicDir)) {
    app.register(fastifyStatic, { root: publicDir, wildcard: false });
  }
  app.setNotFoundHandler((req, reply) => {
    if (existsSync(publicDir) && req.method === 'GET' && !NON_SPA.test(req.url))
      return reply.sendFile('index.html');
    return sendError(reply, notFound());
  });
  return app;
}
