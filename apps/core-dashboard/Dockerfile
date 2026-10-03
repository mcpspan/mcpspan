# syntax=docker/dockerfile:1

# Built from the repository root, not this directory, because a pnpm workspace
# install needs the lockfile and every manifest beside it.
#
#   docker build -f apps/core-dashboard/Dockerfile .

FROM node:24.21.0-alpine AS deps

RUN corepack enable

WORKDIR /app

# Manifests before sources, so editing a page does not reinstall the world.
# Every workspace manifest is copied, not only this app's: pnpm checks the
# lockfile against the whole workspace and refuses a frozen install when one
# is missing.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/core-api/package.json apps/core-api/
COPY apps/core-dashboard/package.json apps/core-dashboard/
COPY packages/mcpspan/package.json packages/mcpspan/

# Development dependencies included on purpose: Tailwind and the TypeScript
# compiler are what turn the sources into a build, so a --prod install here
# would produce nothing to ship.
RUN pnpm install --frozen-lockfile --filter @mcpspan/core-dashboard


FROM node:24.21.0-alpine AS build

RUN corepack enable

WORKDIR /app

COPY --from=deps /app ./
COPY apps/core-dashboard ./apps/core-dashboard

ENV NEXT_TELEMETRY_DISABLED=1

# No build arguments, and none wanted. Every setting this app reads is read on
# the server when a page is rendered, so one image serves every installation
# and a self-hoster changes an address by restarting rather than rebuilding.
# That is why none of them is prefixed NEXT_PUBLIC_, which Next would inline
# here and freeze.
RUN pnpm --filter @mcpspan/core-dashboard build


FROM node:24.21.0-alpine

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=6270 \
    # Without this the server binds to localhost inside the container, where
    # nothing outside it can reach the published port.
    HOSTNAME=0.0.0.0

WORKDIR /app

# Next's standalone output: a server plus only the modules it actually
# reaches, rather than a copy of the workspace.
COPY --from=build /app/apps/core-dashboard/.next/standalone ./

# Not part of standalone output, and the pages are unstyled without it.
COPY --from=build /app/apps/core-dashboard/.next/static ./apps/core-dashboard/.next/static

USER node

EXPOSE 6270

CMD ["node", "apps/core-dashboard/server.js"]
