# SPDX-License-Identifier: AGPL-3.0-or-later
# Builds the probe's downloadable files (build-binary.mjs) and hands them back, no image:
#   docker build -f apps/probe/binary.Dockerfile --output type=local,dest=probe-dist .
FROM node:24-trixie-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends xz-utils \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile --filter @selfphoneng/probe \
 && node apps/probe/build-binary.mjs

FROM scratch
COPY --from=build /src/apps/probe/dist /
