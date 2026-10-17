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
