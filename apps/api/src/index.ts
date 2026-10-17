// SPDX-License-Identifier: AGPL-3.0-or-later
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';

let config;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(err.message);
  process.exit(1);
}

const app = buildApp(config);
await app.listen({ host: '127.0.0.1', port: config.API_PORT });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => void app.close().then(() => process.exit(0)));
}
