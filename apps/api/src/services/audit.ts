// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Db } from '../db/client.ts';
import { auditLog } from '../db/schema.ts';

const SECRET_KEY = /pass|secret|token|pin|enc$/i;

/** Deep copy with every secret-looking key replaced by "********" (02 audit_log.diff). */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '********' : redact(v)]),
    );
  }
  return value;
}

export type AuditEntry = {
  actorUserId?: string | null;
  actorIp?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  summary: string;
  diff?: unknown;
};

export async function audit(db: Db, e: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actorUserId: e.actorUserId ?? null,
    actorIp: e.actorIp ?? null,
    action: e.action,
    entityType: e.entityType ?? null,
    entityId: e.entityId ?? null,
    summary: e.summary,
    diff: e.diff === undefined ? null : redact(e.diff),
  });
}
