# petri. --- Development Plan

**Date:** 6 November 2026\
**Based on:** `docs/architecture.md` v0.2

This plan breaks the roadmap in architecture section 18 into tasks.
Phase 1 is detailed. Later phases are outlined and get detailed when
they start.

Each task is sized to be one pull request. A task is done when its
acceptance criteria pass and CI is green.

------------------------------------------------------------------------

## Environments

  Environment    Machine                       Architecture   Purpose
  -------------- ----------------------------- -------------- ----------------------------
  Development    Raspberry Pi, 4 GB RAM        arm64          Coding, unit and local tests
  CI             GitHub Actions runners        amd64          Checks, tests, image builds
  Production     Proxmox VM (x86-64-v3)        amd64          petri. host

The development machine runs Docker Compose with only the services
needed for the current task. If 4 GB turns out to be too little
(expected first in phase 2, when BuildKit builds run), the options are
to enable zram swap or point the Docker CLI at a remote Docker host.

------------------------------------------------------------------------

## Prerequisites

-   [x] Docker Engine with the Compose and Buildx plugins installed on the
    development machine.
-   [x] pnpm installed (via corepack).
-   [x] GitHub CLI re-authenticated.
-   [x] GitHub repository created (`petri-paas`, public).
-   [x] Open-source license chosen (AGPL-3.0-or-later).

------------------------------------------------------------------------

## Phase 1 --- Foundation

**Goal:** petri. starts, persists data, has a protected admin panel and
a public (empty) gallery.

### 1.1 Monorepo and tooling

-   pnpm workspace with `apps/*` and `packages/*`.
-   Shared `tsconfig` base (strict mode), Node 24 pinned via `engines`
    and `.nvmrc`, `packageManager` field for pnpm.
-   Biome for linting and formatting; Vitest for tests.
-   Root scripts: `check`, `typecheck`, `test`, `build`.
-   `README.md` with setup instructions.

**Done when:** `pnpm check && pnpm typecheck && pnpm test` pass on an
empty workspace.

### 1.2 CI

-   GitHub Actions workflow on push and pull request: install (cached),
    `check`, `typecheck`, `test`, `build`.
-   Integration test job with a PostgreSQL service container (enabled
    once 1.4 lands).
-   Dependabot for npm packages and GitHub Actions.

**Done when:** CI runs on a pull request and blocks merging on failure.

### 1.3 Configuration and local infrastructure

-   `packages/config`: environment variables parsed and validated with
    Zod at startup; the process exits with a clear message on invalid
    configuration.
-   `infrastructure/compose/dev.yml`: PostgreSQL only for now.
-   `.env.example` documenting every variable.

**Done when:** `docker compose up` starts PostgreSQL and a test script
connects with the validated configuration.

### 1.4 Database

-   `packages/database`: Drizzle schema and migrations for `projects`,
    `deployments`, `builds`, `deployment_events` and `api_keys`. The
    tables Better Auth needs are added in 1.6, after the spike.
-   Projects get a `featured_deployment_id` (which deployment the gallery
    shows) and a `visibility` field.
-   Migration command used by both development and production.
-   Integration tests run against a real PostgreSQL.

**Done when:** migrations apply cleanly to an empty database and the
integration tests pass in CI.

### 1.5 API skeleton

-   `apps/api`: Fastify with the Zod type provider, structured logging
    (pino), a consistent error response format and `/api/v1/health`.
-   `packages/contracts`: Zod schemas for projects; OpenAPI generated
    from them and served at `/api/v1/docs`.
-   Project CRUD (`/api/v1/projects`).

**Done when:** project CRUD works end to end with tests, and the OpenAPI
document matches the schemas.

### 1.6 Authentication

-   Spike first: confirm Better Auth works with Fastify and Drizzle,
    password login and a generic OIDC provider. If it falls short,
    fall back to a small in-house session layer and record why.
-   Single owner account, created on first start from environment
    variables or a CLI command. No public sign-up.
-   Server-side sessions, `HttpOnly`/`Secure`/`SameSite` cookies, origin
    checks on state-changing requests, rate-limited login.
-   OIDC prepared behind configuration: unset means password login.
-   Scoped API keys (`deploy:create`, `deploy:read`, ...): random tokens
    shown once, stored hashed, revocable.
-   Three access levels on routes: public (gallery), admin session,
    API key with scopes.

**Done when:** tests prove that every admin route rejects anonymous
requests, keys are limited to their scopes and revoked keys stop
working.

### 1.7 Worker and job queue

-   `apps/worker`: pg-boss setup, graceful shutdown, job retry
    defaults.
-   A placeholder job enqueued by the API in the same transaction as a
    database write, to prove the pattern.
-   `LISTEN/NOTIFY` channel from worker to API for live events.

**Done when:** restarting the worker mid-job loses no jobs, and the
transactional enqueue is covered by a test.

### 1.8 Web app skeleton

-   `apps/web`: Next.js with the gallery at `/` (public, server-rendered,
    empty state), login page and an admin area that requires a session.
-   Basic lab-notebook theme tokens (colors, typography), no detailed
    design yet.
-   API calls through a typed client generated from `packages/contracts`.

**Done when:** an anonymous visitor sees the gallery, is redirected to
login from the admin area and can log in as the owner.

### 1.9 Container images and full-stack Compose

-   Dockerfiles for `web`, `api` and `worker` (multi-stage, non-root).
-   `docker-compose.yml` for the full stack.
-   CI builds `linux/amd64` images on every pull request; publishing to
    GHCR is added when deployment to the production VM starts.

**Done when:** `docker compose up` runs the full stack locally and CI
builds all three images.

------------------------------------------------------------------------

## Phase 2 --- First deployment (outline)

-   `packages/deployment-core`: deployment state machine with an explicit
    transition table (including `STOPPED → DEPLOYING`, redeploy from
    `EXPIRED`, retry from `FAILED`), fully unit-tested.
-   Deployment API endpoints and events.
-   Git source: URL validation (HTTPS only, no private addresses), fetch
    of a fixed commit, record the resolved commit SHA.
-   ZIP upload: size limits, safe extraction, archives kept so they can be
    redeployed.
-   Standalone buildkitd and `BuildKitProvider`; build logs stored as
    files and referenced from the database.
-   Docker socket proxy and `DockerRuntimeProvider`: per-deployment
    network, resource limits, dropped capabilities, non-root where
    possible.
-   Health checks with grace period, retries and clear failure reasons.
-   Live progress via SSE.

**Result:** a project builds and runs locally (no public URL yet).

## Phase 3 --- Public previews (outline)

-   Caddy edge proxy and `CaddyEdgeProxyProvider`; admin API on an
    internal network only.
-   Subdomain generation.
-   Egress filtering on the petri. host: containers and builds cannot
    reach private address ranges. **Required before anything is
    public.**
-   Firewall: only the NPM VM reaches the edge proxy and web ports.
-   Static NPM proxy hosts, documented in `docs/operations.md`.
-   First installation on the production VM.

**Result:** a preview is reachable from outside the homelab.

## Phase 4 --- Dashboard and gallery (outline)

-   Admin dashboard: projects, deployments, logs, actions, API keys.
-   Public gallery with featured deployment, uploaded preview image and
    **Try it** action.
-   Lab-notebook visual design.

## Phase 5 --- Lifecycle and automation (outline)

-   Temporary and permanent modes, TTL extension, cleanup job.
-   Buildpacks via `pack` and Paketo.
-   Redeploy and recovery flows; reconciliation job.
-   API polish for coding assistants.

## Phase 6 --- Hardening (outline)

-   Move builds to a separate VM.
-   Secret encryption review.
-   OIDC configuration guide (e.g. Authentik).
-   Backup and restore procedures.
