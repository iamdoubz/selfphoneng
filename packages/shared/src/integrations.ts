// SPDX-License-Identifier: AGPL-3.0-or-later
// Webhooks (04 §9) and API tokens (04 §2.3), admin only.
import { z } from 'zod';

export const WEBHOOK_EVENTS = [
  'call.started',
  'call.answered',
  'call.ended',
  'voicemail.new',
  'sms.received',
  'sms.sent',
  'emergency.call',
  'trunk.registration_changed',
  'extension.registration_changed',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const WebhookInputSchema = z.object({
  url: z.url({ protocol: /^https?$/, message: 'An http:// or https:// address' }).max(2000),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, 'Pick at least one event'),
  enabled: z.boolean().default(true),
});
export type WebhookInput = z.input<typeof WebhookInputSchema>;

export type WebhookDto = {
  id: string;
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
  /** For checking X-SelfPhoneNG-Signature. */
  secret: string;
  createdAt: string;
};

export type WebhookDeliveryDto = {
  id: number;
  event: string;
  status: 'pending' | 'done' | 'failed';
  attempt: number;
  responseCode: number | null;
  createdAt: string;
  nextAttemptAt: string | null;
};

export const ApiTokenInputSchema = z.object({
  name: z.string().trim().min(1, 'Required').max(100),
});

export type ApiTokenDto = {
  id: string;
  name: string;
  /** The first characters, to recognize it ("sp_AbC1…"). */
  tokenPrefix: string;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
};
