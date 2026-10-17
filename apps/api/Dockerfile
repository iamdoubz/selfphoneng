# SPDX-License-Identifier: AGPL-3.0-or-later
FROM node:24-trixie-slim AS build
RUN npm install -g corepack@latest && corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @selfphoneng/shared build \
 && pnpm --filter @selfphoneng/web build \
 && pnpm --filter @selfphoneng/api build \
 && pnpm --filter @selfphoneng/api deploy --legacy --prod /out

FROM node:24-trixie-slim
# pg_dump must be the same major version as the server (18). Debian's own
# postgresql-client is older, so use the official PostgreSQL apt repo (PGDG).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates curl gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && . /etc/os-release \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-18 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /src/apps/api/dist ./dist
COPY --from=build /src/apps/web/dist ./public
COPY --from=build /src/apps/api/src/db/migrations ./dist/db/migrations
# ponytail: provisioning templates (M10) get their COPY line when they exist.
ENV NODE_ENV=production
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","dist/index.js"]
