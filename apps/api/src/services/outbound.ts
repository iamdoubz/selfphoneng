// SPDX-License-Identifier: AGPL-3.0-or-later
// Outbound routes: the defaults (06 §4) and "which route would this call use?" (04 §7.3).
import { asc, count, eq, inArray } from 'drizzle-orm';
import {
  CLASS_RANK,
  dialedDigits,
  formatNumber,
  patternRegex,
  type RoutePattern,
  type RouteTestResult,
} from '@selfphoneng/shared';
import type { Db } from '../db/client.ts';
import { dids, extensions, outboundRoutes, trunks } from '../db/schema.ts';
import { notFound } from '../errors.ts';
import { getSetting } from './settings.ts';

const TOLL_FREE = ['800', '888', '877', '866', '855', '844', '833'];

/**
 * Created with the first trunk so calls work straight away; international starts disabled.
 * Toll-free comes first: 1NXXNXXXXXX also matches 1800…, and the first matching rule wins.
 */
export async function createDefaultRoutes(db: Db, trunkId: string): Promise<void> {
  const [{ n }] = (await db.select({ n: count() }).from(outboundRoutes)) as [{ n: number }];
  if (n > 0) return;
  await db.insert(outboundRoutes).values([
    {
      name: 'Toll-free',
      position: 0,
      patterns: TOLL_FREE.map((p) => ({ match: `1${p}NXXXXXX`, strip: 0, prepend: '' })),
      requiredClass: 'local',
      trunkIds: [trunkId],
    },
    {
      name: 'Local and national (US/Canada)',
      position: 1,
      patterns: [
        { match: 'NXXNXXXXXX', strip: 0, prepend: '1' },
        { match: '1NXXNXXXXXX', strip: 0, prepend: '' },
      ],
      requiredClass: 'national',
      trunkIds: [trunkId],
    },
    {
      name: 'International',
      position: 2,
      enabled: false, // toll-fraud protection: an admin turns it on deliberately (06 §4)
      patterns: [{ match: '011.', strip: 0, prepend: '' }],
      requiredClass: 'international',
      trunkIds: [trunkId],
    },
  ]);
}

/** Mirrors the generated dialplan: sp-from-ext tries emergency, internal numbers, then routes. */
export async function testRoute(
  db: Db,
  extensionId: string,
  input: string,
): Promise<RouteTestResult> {
  const [ext] = await db.select().from(extensions).where(eq(extensions.id, extensionId));
  if (!ext) throw notFound('Extension not found');
  const n = dialedDigits(input);
  if (n === '911' || n === '9911')
    return { ok: false, reason: 'Emergency call: always allowed, handled by the 911 rules' };
  const [internal] = await db
    .select({ id: extensions.id })
    .from(extensions)
    .where(eq(extensions.number, n));
  if (internal) return { ok: false, reason: `${n} is an internal number, not an outside call` };

  const routes = await db
    .select()
    .from(outboundRoutes)
    .where(eq(outboundRoutes.enabled, true))
    .orderBy(asc(outboundRoutes.position), asc(outboundRoutes.id));
  for (const r of routes) {
    const p = (r.patterns as RoutePattern[]).find((x) => patternRegex(x.match).test(n));
    if (!p) continue;
    if (CLASS_RANK[ext.outboundClass] < CLASS_RANK[r.requiredClass])
      return {
        ok: false,
        routeId: r.id,
        routeName: r.name,
        reason: `Denied: "${r.name}" needs calling permission "${r.requiredClass}", ${ext.number} has "${ext.outboundClass}". The caller hears "no service".`,
      };
    const rows = r.trunkIds.length
      ? await db
          .select({ id: trunks.id, name: trunks.name, enabled: trunks.enabled })
          .from(trunks)
          .where(inArray(trunks.id, r.trunkIds))
      : [];
    const usable = r.trunkIds
      .map((id) => rows.find((t) => t.id === id))
      .filter((t) => t?.enabled)
      .map((t) => ({ id: t!.id, name: t!.name }));
    if (!usable.length)
      return {
        ok: false,
        routeId: r.id,
        routeName: r.name,
        reason: `"${r.name}" matches but none of its trunks is enabled`,
      };
    const cidDid = r.callerIdDidId ?? ext.outboundCallerIdDidId;
    const cidId = cidDid ?? (await getSetting(db, 'routing.defaultCallerIdDidId'));
    const [did] = cidId
      ? await db.select({ number: dids.number }).from(dids).where(eq(dids.id, cidId))
      : [];
    return {
      ok: true,
      routeId: r.id,
      routeName: r.name,
      pattern: p.match,
      dialed: p.prepend + n.slice(p.strip),
      trunks: usable,
      callerId: did ? formatNumber(did.number) : null,
    };
  }
  return { ok: false, reason: 'No enabled route matches this number. The call fails.' };
}
