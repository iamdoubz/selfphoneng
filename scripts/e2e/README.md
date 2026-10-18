# Browser checks

Dependency-free scripts that drive a headless Chromium (Edge/Chrome) over the DevTools
protocol. They need an api serving the built web UI and a fresh database.

```sh
pnpm --filter @selfphoneng/web build && mkdir -p /tmp/sp && cp -r apps/web/dist /tmp/sp/public
# fresh DB, then from /tmp/sp:
DATABASE_URL=postgres://… INITIAL_ADMIN_EMAIL=admin@example.com INITIAL_ADMIN_PASSWORD=initial-admin-pw \
  node --env-file=<repo>/.env --conditions=source <repo>/apps/api/src/index.ts
BROWSER=/usr/bin/chromium node scripts/e2e/m1-t4.mjs http://127.0.0.1:8080 admin@example.com initial-admin-pw /tmp/shots
node scripts/e2e/mobile.mjs http://127.0.0.1:8080 admin@example.com correct-horse-battery-staple /tmp/shots
```

`m1-t4.mjs` is the M1-T4 acceptance flow: forced password change, then create/edit/delete a user.

## M2 live loop (any Docker host, no host networking)

`m2-live.mjs` runs the whole chain on a private Docker network: a test Asterisk with AMI published
on `127.0.0.1:15038`, the api writing config into it, two baresip phones, and the dashboard in a
browser. It checks that a new extension is live in Asterisk within 2 s, both phones show online,
and the dots turn red during a call.

```sh
node scripts/e2e/m2-live.mjs up /tmp/sp-live-conf
# start the api with AMI_PORT=15038 AMI_SECRET=m2-live-secret ASTERISK_CONFIG_DIR=/tmp/sp-live-conf
node scripts/e2e/m1-t4.mjs http://127.0.0.1:8080 admin@example.com initial-admin-pw /tmp/shots
node scripts/e2e/m2-live.mjs check http://127.0.0.1:8080 admin@example.com correct-horse-battery-staple /tmp/shots
node scripts/e2e/m2-live.mjs down
```

`m3-t1.mjs` runs on the same setup (after `m1-t4.mjs`): it starts a fake voip.ms (a second Asterisk
that accepts one sub-account) on the m2-live network, creates the trunk in the UI and waits for
**Registered**, then presses Test. `m3-t2.mjs` (after `m3-t1.mjs`) adds a phone number routed to a user in the UI and
checks `sp-inbound` in Asterisk, and that the extension can no longer be deleted.

`pnpm test:asterisk` (golden-file load test, `call-test.ts` with 30 s two-way audio between two
baresip phones, and `trunk-test.ts` with registration against a fake provider) needs no api at all.
