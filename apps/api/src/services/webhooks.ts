// SPDX-License-Identifier: AGPL-3.0-or-later
// Webhooks (04 §9): events from the live state are queued in webhook_deliveries, then a job POSTs
// them, signed, with retries. Private/loopback targets are refused unless webhooks.allowPrivate.
import { createHmac, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { and, arrayContains, asc, eq, lte } from 'drizzle-orm';
import type { LiveMessage, WebhookEvent } from '@selfphoneng/shared';
import type { Db } from '../db/client.ts';
import { webhookDeliveries, webhooks } from '../db/schema.ts';
import { decrypt } from '../crypto/secrets.ts';
import { getSetting } from './settings.ts';

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 3], // multicast and reserved
] as const)
  blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 127], // :: and ::1 (IPv4-mapped addresses match the IPv4 rules)
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(net, bits, 'ipv6');

export const isPrivateAddress = (ip: string) => blocked.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');

export class BlockedTarget extends Error {
  constructor(ip: string) {
    super(`${ip} is a private address (Settings → Webhooks allows them)`);
  }
}

/** DNS lookup that refuses private addresses: checked at connect time, so rebinding can't dodge it. */
const publicLookup: LookupFunction = (host, opts, cb) =>
  lookup(host, opts, (err, addr, family) => {
    if (err) return cb(err, addr, family);
    const all = Array.isArray(addr) ? addr : [{ address: addr, family }];
    const bad = all.find((a) => isPrivateAddress(a.address));
    if (bad) return cb(new BlockedTarget(bad.address), addr, family);
    cb(null, addr, family);
  });

/** POSTs a signed body; resolves to the HTTP status. No redirects are followed. */
export function postSigned(
  url: string,
  event: string,
  body: string,
  secret: string,
  allowPrivate: boolean,
): Promise<number> {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && isIP(host) && isPrivateAddress(host))
    return Promise.reject(new BlockedTarget(host)); // literal IPs skip the lookup
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? https : http).request(
      u,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': 'SelfPhoneNG-Webhook',
          'x-selfphoneng-event': event,
          'x-selfphoneng-timestamp': ts,
          'x-selfphoneng-signature': `sha256=${sig}`,
        },
        signal: AbortSignal.timeout(10_000),
        ...(allowPrivate ? {} : { lookup: publicLookup }),
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Queues one delivery per enabled webhook that wants this event. */
export async function enqueueWebhook(db: Db, event: WebhookEvent, data: unknown) {
  const hooks = await db
    .select({ id: webhooks.id })
    .from(webhooks)
    .where(and(eq(webhooks.enabled, true), arrayContains(webhooks.events, [event])));
  if (!hooks.length) return;
  const payload = { id: randomUUID(), event, createdAt: new Date().toISOString(), data };
  await db.insert(webhookDeliveries).values(
    hooks.map((h) => ({
      webhookId: h.id,
      event,
      payload,
      status: 'pending',
      nextAttemptAt: new Date(),
    })),
  );
}

/** Waits after a failed attempt 1, 2, … 5; after the 6th try it's failed (04 §9). */
const RETRY_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 12 * 3600_000];

/** Sends what's due (the webhookDelivery job, every 10 s). */
export async function deliverDue(db: Db, now = new Date()) {
  const due = await db
    .select({ d: webhookDeliveries, url: webhooks.url, secretEnc: webhooks.secretEnc })
    .from(webhookDeliveries)
    .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
    .where(
      and(
        eq(webhookDeliveries.status, 'pending'),
        eq(webhooks.enabled, true),
        lte(webhookDeliveries.nextAttemptAt, now),
      ),
    )
    .orderBy(asc(webhookDeliveries.id))
    .limit(20);
  const allowPrivate = await getSetting(db, 'webhooks.allowPrivate');
  await Promise.all(
    due.map(async ({ d, url, secretEnc }) => {
      const code = await postSigned(
        url,
        d.event,
        JSON.stringify(d.payload),
        decrypt(secretEnc),
        allowPrivate,
      ).catch(() => null);
      const attempt = d.attempt + 1;
      const ok = code !== null && code >= 200 && code < 300;
      const retryIn = RETRY_MS[attempt - 1];
      await db
        .update(webhookDeliveries)
        .set({
          attempt,
          responseCode: code,
          status: ok ? 'done' : retryIn ? 'pending' : 'failed',
          nextAttemptAt: ok || !retryIn ? null : new Date(now.getTime() + retryIn),
        })
        .where(eq(webhookDeliveries.id, d.id));
    }),
  );
}

/** Turns live-state messages into webhook events (voicemail.new comes from services/voicemail.ts). */
export function watchWebhooks(
  db: Db,
  live: { on(e: 'message', fn: (m: LiveMessage) => void): unknown },
  log: { error(o: object, m: string): void },
) {
  const calls = new Map<string, { answered: boolean; call: unknown }>();
  const trunks = new Map<string, string>();
  const online = new Map<string, boolean>();
  const send = (event: WebhookEvent, data: unknown) =>
    void enqueueWebhook(db, event, data).catch((err: unknown) =>
      log.error({ err, event }, 'webhook enqueue failed'),
    );
  live.on('message', (m) => {
    switch (m.type) {
      case 'call.updated': {
        const known = calls.get(m.data.linkedid);
        if (!known) send('call.started', m.data);
        if (m.data.answeredAt && !known?.answered) send('call.answered', m.data);
        calls.set(m.data.linkedid, { answered: !!m.data.answeredAt, call: m.data });
        break;
      }
      case 'call.removed': {
        const known = calls.get(m.data.linkedid);
        calls.delete(m.data.linkedid);
        if (known)
          send('call.ended', { ...(known.call as object), endedAt: new Date().toISOString() });
        break;
      }
      case 'emergency.call':
        send('emergency.call', m.data);
        break;
      case 'trunk.updated': {
        const prev = trunks.get(m.data.trunkId);
        trunks.set(m.data.trunkId, m.data.registration);
        if (prev && prev !== m.data.registration)
          send('trunk.registration_changed', { ...m.data, previous: prev });
        break;
      }
      case 'extension.updated': {
        const prev = online.get(m.data.number);
        online.set(m.data.number, m.data.online);
        if (prev !== undefined && prev !== m.data.online)
          send('extension.registration_changed', {
            number: m.data.number,
            name: m.data.name,
            online: m.data.online,
          });
        break;
      }
    }
  });
}
