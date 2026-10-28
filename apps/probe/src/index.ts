// SPDX-License-Identifier: AGPL-3.0-or-later
// The network test probe (08 §2.6): run it outside the network SelfPhoneNG is in, and put its URL
// in Settings → Network. `node src/index.ts` (Node 24 runs TypeScript as is).
//   PORT (default 8080), TRUST_PROXY=true behind a reverse proxy on this machine that sets
//   X-Forwarded-For. HOST: where to listen; with TRUST_PROXY=true 127.0.0.1 (only the proxy may
//   reach it), else every address. PROBE_KEY: the key from SelfPhoneNG's Settings → Network;
//   without one anyone who finds the probe can use it.
import { createProbe } from './server.ts';

const port = Number(process.env.PORT ?? 8080);
const trustProxy = process.env.TRUST_PROXY === 'true';
const host = process.env.HOST ?? (trustProxy ? '127.0.0.1' : '::');
const key = process.env.PROBE_KEY || undefined;
const probe = createProbe({ trustProxy, key });
probe.listen(port, host, () => console.log(`selfphoneng-probe listening on ${host} ${port}`));
if (!key)
  console.warn(
    'No PROBE_KEY: anyone who finds this probe can use it. Make one in SelfPhoneNG ' +
      '(Settings → Network → Generate key) and set PROBE_KEY.',
  );
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => probe.close(() => process.exit(0)));
