// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

const EnvSchema = z.object({
  APP_SECRET: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 random bytes, base64'),
  PUBLIC_HOSTNAME: z.string().min(1),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
  INITIAL_ADMIN_EMAIL: z.email(),
  INITIAL_ADMIN_PASSWORD: z.string().min(1),
  AMI_HOST: z.string().default('127.0.0.1'),
  AMI_PORT: z.coerce.number().int().min(1).max(65535).default(5038),
  AMI_USERNAME: z.string().default('selfphoneng'),
  AMI_SECRET: z.string().min(8),
  /** Where generated Asterisk config goes (03 §3). Dev: ../../data/asterisk-generated */
  ASTERISK_CONFIG_DIR: z.string().default('/etc/asterisk/selfphoneng'),
  /** Asterisk's voicemail spool, shared with the api (04 §5.6). Dev: ../../data/voicemail */
  VOICEMAIL_DIR: z.string().default('/var/spool/asterisk/voicemail'),
  /** Uploaded prompts, played as custom/<id> (04 §6). Dev: ../../data/sounds-custom */
  SOUNDS_DIR: z.string().default('/var/lib/asterisk/sounds/custom'),
  /** Music-on-hold classes, one folder each (04 §6, 03 §8). Dev: ../../data/moh */
  MOH_DIR: z.string().default('/var/lib/asterisk/moh'),
  /** voip.ms REST endpoint (06 §5.1); tests and e2e point it at a fake. */
  VOIPMS_API_URL: z.url().default('https://voip.ms/api/v1/rest.php'),
  /** MixMonitor's directory; recordings are YYYY/MM/DD/<uniqueid>.wav under it (03 sp-sub-record). */
  RECORDINGS_DIR: z.string().default('/var/spool/asterisk/monitor'),
  /** The browser softphone's SIP WebSocket. Default wss://PUBLIC_HOSTNAME/ws (the reverse proxy). */
  WEBRTC_WS_URL: z.url().optional(),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  TRUST_PROXY: z.stringbool().default(true),
  TZ: z.string().default('America/Chicago'),
});

export type Config = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // `pnpm dev` reads .env, which has no DATABASE_URL (compose builds it); point at the dev container.
  if (!env.DATABASE_URL && env.POSTGRES_PASSWORD)
    env = {
      ...env,
      DATABASE_URL: `postgres://selfphoneng:${env.POSTGRES_PASSWORD}@127.0.0.1:${env.POSTGRES_PORT ?? 5433}/selfphoneng`,
    };
  const r = EnvSchema.safeParse(env);
  if (r.success) return r.data;
  const lines = r.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
  throw new ConfigError(`Invalid environment (see .env.example):\n${lines.join('\n')}`);
}
