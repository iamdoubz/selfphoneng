// SPDX-License-Identifier: AGPL-3.0-or-later
// One zod schema (with its default) per settings key (spec 02 §3).
import { z } from 'zod';
import { DestinationSchema } from './destination.ts';

const range = (from: number, to: number) =>
  z
    .tuple([z.number().int().min(0), z.number().int().max(999999)])
    .refine(([a, b]) => a <= b, 'range start must be <= end')
    .default([from, to]);

export const SettingsSchemas = {
  'general.companyName': z.string().trim().min(1).max(100).default('My Company'),
  // The api replaces this default with env TZ (services/settings.ts).
  'general.timezone': z.string().min(1).default('America/Chicago'),
  'general.language': z.string().min(2).max(10).default('en'),
  'network.publicIp': z.ipv4().nullable().default(null),
  'network.localNets': z
    .array(z.cidrv4())
    .default(['192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12']),
  'network.lanIp': z.ipv4().nullable().default(null),
  'network.publicIpWatch': z.boolean().default(false),
  /** The network test probe (apps/probe), outside this network; null: no outside tests (08 §2.6). */
  'network.probeUrl': z
    .url({ protocol: /^https?$/ })
    .nullable()
    .default(null),
  'network.stunServer': z
    .string()
    .regex(/^[A-Za-z0-9.-]+(:\d{1,5})?$/)
    .nullable()
    .default(null),
  'network.turn': z
    .object({ url: z.string().min(1), username: z.string(), credentialEnc: z.string() })
    .nullable()
    .default(null),
  'sip.udpPort': z.number().int().min(1).max(65535).default(5060),
  'sip.tcpEnabled': z.boolean().default(true),
  'sip.tlsEnabled': z.boolean().default(false),
  'sip.tlsPort': z.number().int().min(1).max(65535).default(5061),
  'numbering.users': range(100, 499),
  'numbering.ringGroups': range(500, 549),
  'numbering.queues': range(550, 599),
  'numbering.ivrs': range(600, 649),
  'numbering.conferences': range(800, 849),
  'numbering.paging': range(850, 869),
  'routing.unmatchedDidDestination': DestinationSchema.default({ type: 'hangup' }),
  'routing.defaultCallerIdDidId': z.uuid().nullable().default(null),
  smtp: z
    .object({
      host: z.string().min(1),
      port: z.number().int().min(1).max(65535),
      secure: z.boolean(),
      username: z.string(),
      passwordEnc: z.string(),
      from: z.string().min(3),
    })
    .nullable()
    .default(null),
  'voicemail.maxMessageSeconds': z.number().int().min(10).max(3600).default(300),
  'voicemail.maxMessages': z.number().int().min(1).max(9999).default(100),
  'voicemail.retentionDays': z.number().int().min(0).default(0),
  'recordings.retentionDays': z.number().int().min(0).default(90),
  'recordings.announcementSoundId': z.uuid().nullable().default(null),
  'emergency.defaultCallerIdDidId': z.uuid().nullable().default(null),
  'emergency.notifyEmails': z.array(z.email()).default([]),
  'emergency.notifyExtensionIds': z.array(z.uuid()).default([]),
  'backup.enabled': z.boolean().default(true),
  'backup.time': z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default('03:30'),
  'backup.keep': z.number().int().min(1).max(365).default(7),
  'backup.includeRecordings': z.boolean().default(false),
  'webhooks.allowPrivate': z.boolean().default(false),
  'setup.completed': z.boolean().default(false),
  // The api generates and stores a random value on first read (services/settings.ts).
  'sms.webhookToken': z.string().regex(/^[A-Za-z0-9]{32}$/),
  'sip.restrictPhonesToLocalNets': z.boolean().default(false),
  'sip.extraAllowedNets': z.array(z.cidrv4()).default([]),
  // Toll fraud (08 §1): outside calls going out at once, per extension and in total. 0 = no limit.
  'calls.maxPerExtension': z.number().int().min(0).max(100).default(3),
  'calls.maxTotal': z.number().int().min(0).max(1000).default(10),
  'provisioning.lanOnly': z.boolean().default(false),
  'provisioning.enabled': z.boolean().default(true),
  'system.restartRequired': z.boolean().default(false),
  // Not in 02 §3's table but used by the generator (03 §3).
  'system.transportHash': z.string().nullable().default(null),
};

export type SettingKey = keyof typeof SettingsSchemas;
export type SettingValue<K extends SettingKey> = z.output<(typeof SettingsSchemas)[K]>;

/** PATCH /api/settings `smtp`: the password is write-only (empty keeps the stored one). */
export const SmtpInputSchema = z.object({
  host: z.string().trim().min(1, 'Required'),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().trim(),
  password: z.string().max(256).optional(),
  from: z.string().trim().min(3, 'Like "Phone system <pbx@example.com>"'),
});
export type SmtpInput = z.input<typeof SmtpInputSchema>;

/** GET /api/settings: every key, secrets replaced by hasPassword. */
export type SettingsDto = {
  [K in Exclude<SettingKey, 'smtp' | 'sms.webhookToken'>]: SettingValue<K>;
} & {
  smtp: (Omit<SmtpInput, 'password'> & { hasPassword: boolean }) | null;
};

/** GET /api/system/warnings: shown as the dashboard banner (05 §2). */
export type Warning = { code: string; message: string; link: string };

/** GET /api/system/backups (04 §8.1). */
export type BackupDto = { name: string; size: number; createdAt: string };

/** GET /api/system/tls: the SIP TLS certificate in data/tls (M11-T2). */
export type TlsCert =
  { ok: true; subject: string; names: string[]; notAfter: string } | { ok: false; error: string };

/** GET /api/system/status: the System page's "System information" (05 §2). */
export type SystemStatus = {
  version: string;
  hostname: string;
  companyName: string;
  publicIp: string | null;
  /** Re-checked every 5 minutes (network.publicIpWatch). */
  publicIpDynamic: boolean;
  lanIps: string[];
  ports: { sip: number; sipTcp: boolean; sips: number | null; rtp: string; https: number };
  ami: { connected: boolean };
  restartRequired: boolean;
};

/** One line of System → Diagnostics (08 §2.6). `fix` says what to do when it isn't ok. */
export type DiagnosticCheck = {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  detail: string;
  fix?: string;
};

/** GET /api/system/diagnostics: what the server can check from the inside. */
export type DiagnosticsDto = { checks: DiagnosticCheck[] };

/** POST /api/system/diagnostics/network {mode}: the probe's outside view of the server. */
export type NetworkTestDto = {
  mode: 'quick' | 'complete';
  /** The address the probe tested: the one this server reaches the internet from. */
  testedIp: string | null;
  checks: DiagnosticCheck[];
};

/** GET /api/system/events: the System page's event log, newest first. */
export type SystemEventDto = {
  id: number;
  createdAt: string;
  severity: 'info' | 'warning' | 'error';
  code: string;
  source: string;
  message: string;
};

/** GET /api/about (no sign-in): what runs here and where its source is (AGPL, 08 §4). */
export type AboutDto = {
  version: string;
  repoUrl: string;
  /** The source this build was made from (selfphone.tar.gz); null outside a Docker build. */
  source: { bytes: number; builtAt: string } | null;
};
