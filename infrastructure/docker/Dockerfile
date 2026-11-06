# syntax=docker/dockerfile:1
#
# Images for all petri. services, one target each:
#   docker build -f infrastructure/docker/Dockerfile --target api .
# Targets: api, worker, web. Normally built through docker-compose.yml.

ARG NODE_IMAGE=node:24-alpine

# --- Build: install, compile, and assemble each service -------------------
FROM ${NODE_IMAGE} AS build
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# Download dependencies using only the lockfile, so this layer stays cached
# until dependencies change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
	pnpm fetch --store-dir /pnpm-store

COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
	pnpm install --offline --frozen-lockfile --store-dir /pnpm-store

# The web app's /api/v1 forwarding target is fixed at build time.
ARG API_INTERNAL_URL=http://api:4000
RUN API_INTERNAL_URL=${API_INTERNAL_URL} pnpm -r build

# Self-contained production installs. --no-optional leaves out optional
# peer dependencies (e.g. Better Auth's link to next/react), which pnpm
# would otherwise resolve against other workspace packages.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
	pnpm --filter @petri/api deploy --legacy --prod --no-optional \
		--store-dir /pnpm-store /out/api && \
	pnpm --filter @petri/worker deploy --legacy --prod --no-optional \
		--store-dir /pnpm-store /out/worker

# --- Runtime images --------------------------------------------------------
# Code is owned by root and read-only for the `node` user the services run as.

FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=4000 \
	UPLOADS_DIR=/var/lib/petri/uploads
WORKDIR /app
COPY --from=build /out/api ./
# Uploaded archives (a volume shared with the worker). Created here so the
# volume starts out owned by the unprivileged user.
RUN mkdir -p /var/lib/petri/uploads && chown node:node /var/lib/petri/uploads
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]

# The worker fetches sources with git and drives BuildKit with buildctl
# (same version as the buildkitd service).
FROM moby/buildkit:v0.34.2-rootless AS buildkit

FROM ${NODE_IMAGE} AS worker
ENV NODE_ENV=production UPLOADS_DIR=/var/lib/petri/uploads \
	BUILDKIT_HOST=tcp://buildkitd:1234
RUN apk add --no-cache git
COPY --from=buildkit /usr/bin/buildctl /usr/local/bin/buildctl
WORKDIR /app
COPY --from=build /out/worker ./
RUN mkdir -p /var/lib/petri/uploads && chown node:node /var/lib/petri/uploads
USER node
CMD ["node", "dist/main.js"]

FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
# Next.js writes its runtime cache here.
RUN mkdir -p apps/web/.next/cache && chown node:node apps/web/.next/cache
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
