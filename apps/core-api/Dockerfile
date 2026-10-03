# syntax=docker/dockerfile:1

# Node 24 runs TypeScript directly, so this app has no build step: what ships
# in the image is the source, and there is no compiled copy that can drift
# from it.
#
# Built from the repository root, not this directory, because a pnpm workspace
# install needs the lockfile and every manifest beside it.
#
#   docker build -f apps/core-api/Dockerfile .

# Pinned to a patch. A base image that moves underneath a self-hosted
# deployment is the kind of change that gets discovered during an incident.
FROM node:24.21.0-alpine AS deps

RUN corepack enable

WORKDIR /app

# Manifests before sources, so editing a route does not reinstall the world.
# Every workspace manifest is copied, not only this app's: pnpm checks the
# lockfile against the whole workspace and refuses a frozen install when one
# is missing.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/core-api/package.json apps/core-api/
COPY apps/core-dashboard/package.json apps/core-dashboard/
COPY packages/mcpspan/package.json packages/mcpspan/

# --prod leaves out vitest and the compiler. They are needed to develop this
# app and not to run it, and an unused dependency in a deployed image is
# attack surface that earns nothing.
RUN pnpm install --frozen-lockfile --filter @mcpspan/core-api --prod


FROM node:24.21.0-alpine

ENV NODE_ENV=production

WORKDIR /app

# Both trees, and in this shape. pnpm links a package's dependencies from
# `apps/core-api/node_modules` into a store under the root `node_modules`, so
# the two only resolve when their relative positions are preserved.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/core-api/node_modules ./apps/core-api/node_modules
COPY apps/core-api ./apps/core-api

# Where the API keeps the signing secret it makes on first start, when none is
# given. Owned by the unprivileged user, and copied that way into the volume
# Compose mounts here.
RUN mkdir -p /var/lib/mcpspan && chown node:node /var/lib/mcpspan

# Unprivileged, and without write access to its own code. The image ships with
# a `node` user for exactly this.
USER node

WORKDIR /app/apps/core-api

EXPOSE 6271

CMD ["node", "src/index.ts"]
