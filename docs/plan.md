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
    **Result:** Better Auth 1.7 passed (password login, disabled
    sign-up, rate limiting, OIDC redirect with PKCE); kept.
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
-   A placeholder job enqueued in the same transaction as a database
    write, to prove the pattern. (Done in `packages/jobs` tests with a
    `system.ping` job; the API's first real job is the deployment job in
    phase 2.)
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

## Phase 2 --- First deployment

**Goal:** a deployment created through the API is fetched, built, run and
health-checked, with live progress. No public URL yet (phase 3).

**Safety while developing:** builds and apps run on the development
machine and can reach the LAN until egress filtering lands in phase 3.
Until then, deploy only your own repositories.

### Defaults

Configurable later; these are the starting values.

  Setting                       Default
  ----------------------------- -------------------------------------
  Git clone timeout             2 minutes
  Repository size limit         500 MB
  ZIP upload limit              100 MB compressed, 500 MB extracted,
                                20,000 files
  Build timeout                 15 minutes
  Container memory              512 MB
  Container CPU                 1 core
  Container processes           256
  Health check                  HTTP GET `/`, any status below 500;
                                30 s grace, every 2 s, 60 s timeout
  Temporary deployment TTL      48 hours

### 2.1 Deployment state machine

-   `packages/deployment-core`: statuses and an explicit transition
    table, as pure code with no I/O.
-   Covers the normal path (queued → cloning → building → deploying →
    health_check → ready), failure from any active step, stop/start,
    redeploy from ready/stopped/failed/expired, and deletion.
-   Every transition records a `deployment_events` row and publishes a
    live event, in the same transaction as the status change.

**Done when:** every allowed transition and a sample of forbidden ones
are covered by unit tests; status changes go through one function.

### 2.2 Deployment API

-   `POST /deployments` (Git source), `GET /deployments`,
    `GET /deployments/:id`, `GET /deployments/:id/events`.
-   Creating a deployment writes the deployment, its first build and the
    `deployment.run` job in one transaction (first real use of the
    transactional enqueue from 1.7).
-   Subdomain from project slug and deployment name, made unique;
    lifecycle `temporary` (with `ttlHours`) or `permanent`.
-   Request body as in architecture section 12.3; `project` accepts a
    slug and creates the project if it doesn't exist (one call for
    coding assistants).

**Done when:** deployments can be created and listed with the right
scopes, and a rolled-back request leaves no job behind.

### 2.3 Git source

-   HTTPS URLs only; the host must resolve to public addresses only
    (checked again right before fetching, against DNS rebinding).
-   Shallow fetch of the requested branch, tag or commit; record the
    resolved commit SHA on the build.
-   Time and size limits; no Git hooks, no submodules, no credential
    prompts.
-   A fresh workspace directory per build, removed afterwards.

**Done when:** tests cover allowed/blocked URLs (private ranges,
localhost, link-local, IPv6 forms, redirects), and a public repository
is fetched at a pinned commit.

### 2.4 ZIP upload

-   `POST /deployments/upload` (multipart): archive plus the same
    settings as 2.2.
-   Rejects path traversal, absolute paths, symlinks and device files;
    enforces size and file-count limits while extracting (zip bombs).
-   Archives are kept in an uploads volume so deployments can be rebuilt.

**Done when:** a set of malicious test archives is rejected and a valid
one deploys.

### 2.5 Builds with BuildKit

-   Rootless `buildkitd` as its own service (dev and production
    Compose). Verified on the dev machine: build steps run as an
    unprivileged user on the host.
-   `BuildKitProvider`: Dockerfile builds via `buildctl`; the image is
    exported and loaded into Docker; optional build directory and build
    arguments.
-   Build logs streamed to a file per build (`builds.log_path`) and to
    live events; secrets never written to logs.
-   Build timeout; failed builds keep their log.

**Done when:** a sample app with a Dockerfile builds; a failing
Dockerfile ends the deployment as `failed` with the error and log kept.

### 2.6 Runtime with Docker

-   Docker socket proxy: the worker reaches Docker only through it,
    limited to the containers, images and networks API.
-   `DockerRuntimeProvider`: one network per deployment; container with
    the resource limits above, all capabilities dropped,
    `no-new-privileges`, no published ports, labels linking it to the
    deployment.
-   Idempotent: a retried job finds and reuses or replaces its own
    container instead of creating a duplicate.

**Done when:** a built image runs with the limits applied (checked via
the Docker API in tests), and a retried job doesn't duplicate containers.

### 2.7 Health checks and the deployment job

-   `deployment.run` job: fetch → build → create container → start →
    health check → `ready`, recording each step.
-   The worker joins the deployment's network only to probe it.
-   On failure: record the failed step and reason, keep logs, remove
    what the attempt created.

**Done when:** a working app reaches `ready`; an app that never answers,
crashes on start or listens on the wrong port fails with a clear reason.

### 2.8 Live progress and logs

-   `GET /deployments/:id/events/stream`: Server-Sent Events, replaying
    stored events first (`Last-Event-ID`) and then live ones.
-   `GET /deployments/:id/logs`: build log, and runtime logs from Docker.

**Done when:** a client connecting mid-deployment sees every event
exactly once, in order.

**Changed:** runtime logs (the app's own output) are not served by the
API in this task. The API has no Docker access by design; even read-only
access would let it inspect every container, including petri.'s own
secrets. Proposed instead: the API asks the worker for the last lines
through the job queue, and the worker writes them to the shared logs
volume. Until then, the app's last output on a failed start is in the
build log (task 2.7).

### 2.9 Stop, start and delete

-   `POST /deployments/:id/stop`, `POST /deployments/:id/start`,
    `DELETE /deployments/:id` (removes container, network and image;
    keeps history unless the project is deleted).
-   Redeploy and automatic expiry follow in phase 5.

**Done when:** each action works from the matching states and is
refused from the others.

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
