// SPDX-License-Identifier: AGPL-3.0-or-later
// The network test probe (08 §2.6): run it outside the network SelfPhoneNG is in, and put its URL
// in Settings → Network. `node src/index.ts` (Node 24 runs TypeScript as is).
//   PORT (default 8080), TRUST_PROXY=true behind a reverse proxy that sets X-Forwarded-For.
import { createProbe } from './server.ts';

const port = Number(process.env.PORT ?? 8080);
const probe = createProbe({ trustProxy: process.env.TRUST_PROXY === 'true' });
probe.listen(port, () => console.log(`selfphoneng-probe listening on ${port}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => probe.close(() => process.exit(0)));
