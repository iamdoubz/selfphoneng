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
