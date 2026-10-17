// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

// ponytail: only the vars used so far; DB/AMI/admin vars join in M1/M2 with the code that reads them.
const EnvSchema = z.object({
  APP_SECRET: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 random bytes, base64'),
  PUBLIC_HOSTNAME: z.string().min(1),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  TRUST_PROXY: z.stringbool().default(true),
  TZ: z.string().default('America/Chicago'),
});

export type Config = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = EnvSchema.safeParse(env);
  if (r.success) return r.data;
  const lines = r.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
  throw new ConfigError(`Invalid environment (see .env.example):\n${lines.join('\n')}`);
}
