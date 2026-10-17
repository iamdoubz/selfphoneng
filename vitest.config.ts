// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';

// DB integration tests use TEST_DATABASE_URL; derive it from .env for the dev postgres container.
try {
  process.loadEnvFile('.env');
} catch {
  // no .env (CI sets TEST_DATABASE_URL itself, or DB tests are skipped)
}
const env = process.env;
if (!env.TEST_DATABASE_URL && env.POSTGRES_PASSWORD) {
  env.TEST_DATABASE_URL = `postgres://selfphoneng:${env.POSTGRES_PASSWORD}@127.0.0.1:${env.POSTGRES_PORT ?? 5433}/selfphoneng`;
}

export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'], externalConditions: ['source'] } },
  test: {
    include: ['{apps,packages}/*/{src,test}/**/*.test.{ts,tsx}'],
    passWithNoTests: true,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
