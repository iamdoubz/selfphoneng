// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/live WebSocket (04 §5.2): a snapshot on connect, then batched deltas.
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import type { ExtensionLive, LiveMessage } from '@selfphoneng/shared';
import { COOKIE, getSessionUser } from '../auth/sessions.ts';
import type { LiveState } from './state.ts';

const BATCH_MS = 250;
const PING_MS = 30_000;

type Client = {
  ws: WebSocket;
  admin: boolean;
  /** `${type}:${key}` → latest message, so many updates of one thing collapse into one. */
  pending: Map<string, LiveMessage>;
  alive: boolean;
};

declare module 'fastify' {
  interface FastifyInstance {
    live: LiveState;
  }
}

export async function liveRoutes(app: FastifyInstance) {
  const clients = new Set<Client>();

  const keyOf = (m: LiveMessage) =>
    m.type === 'extension.updated' || m.type === 'extension.removed'
      ? `extension:${m.data.number}` // a removal replaces a pending update and vice versa
      : m.type;

  app.live.on('message', (m) => {
    for (const c of clients) c.pending.set(keyOf(m), m);
  });

  const viewFor = (c: Client, m: LiveMessage): LiveMessage =>
    m.type === 'extension.updated'
      ? {
          type: m.type,
          data: app.live.view(m.data as ExtensionLive & { contacts: [] }, c.admin),
        }
      : m;

  const flush = setInterval(() => {
    for (const c of clients) {
      if (!c.pending.size) continue;
      for (const m of c.pending.values()) c.ws.send(JSON.stringify(viewFor(c, m)));
      c.pending.clear();
    }
  }, BATCH_MS);

  const ping = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.ws.terminate(); // missed the last ping
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, PING_MS);

  app.addHook('onClose', async () => {
    clearInterval(flush);
    clearInterval(ping);
    for (const c of clients) c.ws.close(1001, 'server shutting down');
  });

  app.get('/api/live', { websocket: true }, async (ws, req) => {
    const token = req.cookies[COOKIE];
    const found = token ? await getSessionUser(app.db, token) : null;
    // Browsers can't read an HTTP 401 on an upgrade, so open and close with 4401 (04 §5.2).
    if (!found || found.user.mustChangePassword) return ws.close(4401, 'unauthorized');
    const c: Client = { ws, admin: found.user.role === 'admin', pending: new Map(), alive: true };
    clients.add(c);
    ws.on('pong', () => (c.alive = true));
    ws.on('close', () => clients.delete(c));
    ws.send(
      JSON.stringify({ type: 'snapshot', data: app.live.snapshot(c.admin) } satisfies LiveMessage),
    );
  });
}
