# SPDX-License-Identifier: AGPL-3.0-or-later
# The network test probe (08 §2.6), run outside the network SelfPhoneNG is in. No dependencies:
# Node 24 runs the TypeScript as it is. Build from the repo root:
#   docker build -f apps/probe/Dockerfile -t selfphoneng-probe .
FROM node:24-alpine
WORKDIR /app
COPY apps/probe/package.json ./
COPY apps/probe/src/checks.ts apps/probe/src/server.ts apps/probe/src/index.ts ./src/
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "src/index.ts"]
