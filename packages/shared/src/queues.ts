// SPDX-License-Identifier: AGPL-3.0-or-later
// Queues (02 queues, 03 §6.8): callers wait with music until an agent is free.
import { z } from 'zod';
import { DestinationSchema, type Destination } from './destination.ts';
import { InternalNumber } from './extensions.ts';

export const QUEUE_STRATEGIES = [
  'ringall',
  'leastrecent',
  'fewestcalls',
  'random',
  'rrmemory',
  'linear',
] as const;

const QueueFields = z.object({
  number: InternalNumber,
  name: z.string().trim().min(1, 'Required').max(40),
  strategy: z.enum(QUEUE_STRATEGIES),
  memberRingSeconds: z.number().int().min(5).max(120),
  retrySeconds: z.number().int().min(0).max(60),
  wrapupSeconds: z.number().int().min(0).max(600),
  maxWaitSeconds: z.number().int().min(10).max(7200),
  /** 0 = unlimited. */
  maxCallers: z.number().int().min(0).max(500),
  /** M8-T5 adds classes; until then only "default" exists. */
  mohClass: z.string().regex(/^[a-z0-9-]{1,40}$/, 'Lowercase letters, digits and - only'),
  announcePosition: z.boolean(),
  announceEverySeconds: z.number().int().min(15).max(600),
  joinWhenNoAgents: z.boolean(),
  record: z.boolean(),
  slaSeconds: z.number().int().min(1).max(3600),
  /** Shown before the caller's name. Same rules as caller ID names (03 §2). */
  callerIdNamePrefix: z
    .string()
    .max(20)
    .regex(/^[^"'\\;,()[\]{}$<>|]*$/, 'No quotes, commas, brackets or ; $ < > |')
    .nullable(),
  /** Agents; a lower penalty gets calls first. */
  members: z
    .array(z.object({ extensionId: z.uuid(), penalty: z.number().int().min(0).max(10) }))
    .max(100)
    .refine(
      (ms) => new Set(ms.map((m) => m.extensionId)).size === ms.length,
      'Someone is listed twice',
    ),
  timeoutDestination: DestinationSchema,
});

export const QueueCreateSchema = QueueFields.partial().required({
  number: true,
  name: true,
  timeoutDestination: true,
});
export const QueueUpdateSchema = QueueFields.partial();
export type QueueCreate = z.input<typeof QueueCreateSchema>;
export type QueueUpdate = z.input<typeof QueueUpdateSchema>;

export type QueueMemberDto = { extensionId: string; penalty: number; paused: boolean };

export type QueueDto = Omit<z.output<typeof QueueFields>, 'members'> & {
  id: string;
  members: QueueMemberDto[];
  timeoutDestination: Destination;
  timeoutSummary: string;
  createdAt: string;
};

/** GET /api/queues/:id/stats (and the reports queue table later). */
export type QueueStats = {
  offered: number;
  answered: number;
  abandoned: number;
  /** Went to the timeout destination (waited too long, full, no agents). */
  timedOut: number;
  /** Seconds, over answered calls; null when none. */
  avgWaitSeconds: number | null;
  /** % of answered calls picked up within sla_seconds; null when none. */
  withinSlaPercent: number | null;
};
