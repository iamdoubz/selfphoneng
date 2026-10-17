// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Config } from './config.ts';

// Paths the SPA must never swallow (04 §1 step 5).
const NON_SPA = /^\/(api|prov|hooks)(\/|$)/;

export function buildApp(config: Config, publicDir = resolve('public')) {
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

  app.get('/healthz', async () => ({ ok: true }));

  if (existsSync(publicDir)) {
    app.register(fastifyStatic, { root: publicDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !NON_SPA.test(req.url)) return reply.sendFile('index.html');
      return reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'Not found', details: {} } });
    });
  }
  return app;
}
