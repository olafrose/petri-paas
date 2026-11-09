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
  Development    Proxmox VM, 4 vCPU, 8 GB RAM  amd64          Coding, unit and integration tests
  CI             GitHub Actions runners        amd64          Checks, tests, image builds
  Production     Proxmox VM (x86-64-v3)        amd64          petri. host

The development machine runs the services from
`infrastructure/compose/dev.yml` (PostgreSQL, BuildKit, the Docker socket
proxy, the edge proxy) and, since 3.3, the same egress firewall as
production.

**Changed:** phases 1 and 2 were developed on a Raspberry Pi 5 (arm64,
4 GB RAM). Development moved to a Proxmox VM for more room to run the
integration tests, which build and run images. Development, CI and
production now share one architecture.

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

**Changed:** deleting a project is refused (409) until all its
deployments are `deleted`. Removing the project's rows would otherwise
drop petri.'s only reference to containers that are still running. A
deployment's history therefore goes with its project, as planned, but
only after its resources are gone. Deletion also removes the uploaded
ZIP archive, which only served rebuilds.

**Result:** a project builds and runs locally (no public URL yet).

## Phase 3 --- Public previews

**Goal:** a ready deployment is reachable at its public URL through NPM
and the petri. edge proxy, and nothing petri. runs can reach the LAN.

**Order matters:** 3.3 (egress filtering) must be in place on the
production host before 3.5 makes anything public.

Subdomain generation, listed in the outline, was done in 2.2 (unique,
DNS-safe, from project and deployment name); 3.2 turns it into a URL.

### 3.1 Edge proxy

-   Caddy as its own service (dev and production Compose), publishing
    one port for preview traffic (`EDGE_BIND:EDGE_PORT`). Unknown
    hostnames get a 404 from Caddy itself and never fall through.
-   **Admin API on a Unix socket** in a volume shared only with the
    worker. Not on a network: the edge proxy joins every deployment's
    network, and Caddy's admin API has no authentication, so a TCP
    listener would let any app rewrite the routes.
-   `packages/edge-proxy`: `CaddyEdgeProxyProvider` with idempotent
    `setRoute` (hostname → container and port, keyed by deployment),
    `removeRoute` and `listRoutes`, using Caddy's `@id` addressing.
-   `X-Forwarded-*` trusted only from configured proxies (the NPM VM in
    production); WebSockets pass through.

**Done when:** integration tests against a real Caddy show that routes
are created, replaced and removed idempotently; that an unknown host
gets 404; and that the admin API is not reachable over the network.

### 3.2 Routes in the deployment lifecycle

-   `PREVIEW_DOMAIN` (e.g. `app.example.com`; `app.localhost` in
    development) and `PREVIEW_SCHEME`; the API returns each deployment's
    `url`.
-   Deployment and start jobs: after the health check, the edge proxy
    joins the deployment's network and the route is set, then `ready`.
    A broken app is never routed.
-   Stop, delete, failure and expiry remove the route first; delete
    also disconnects the edge proxy, or the network can't be removed.
-   Routes are rebuilt from the database when the worker starts and
    checked every few minutes, so a restarted Caddy (which forgets
    routes set through its API) recovers by itself.

**Done when:** a ready deployment answers through the edge proxy by
hostname; stopped and deleted ones get 404; routes come back after
Caddy restarts; route failures leave the deployment retryable, not
half-ready.

### 3.3 Egress filtering

-   Deployment networks get their subnets from a dedicated pool
    (`APP_SUBNET_POOL`), and BuildKit its own network, so host rules
    can tell petri.'s traffic apart.
-   nftables rules on the host (`infrastructure/firewall/`, applied by a
    systemd unit): from those subnets, new connections to private and
    special ranges are dropped (RFC 1918, loopback, link-local
    including `169.254.169.254`, CGNAT `100.64.0.0/10`, IPv6 ULA and
    link-local), as are connections to the host's own addresses.
    Replies (the edge proxy and worker talking to an app) still work;
    DNS goes through Docker's resolver.
-   A probe script that runs a container on a deployment network and a
    build step, and checks what they can and can't reach.

**Done when:** the probe passes in CI and on the development machine:
public internet reachable; the LAN, the host, metadata addresses and
other deployments are not; previews still answer through the edge
proxy.

### 3.4 Production setup

-   CI publishes `linux/amd64` images to GHCR from `main`; the
    production Compose file uses them instead of building.
-   Host firewall (same nftables setup): only the NPM VM reaches the web
    and edge ports; SSH from the admin network only. `TRUST_PROXY` and
    the edge proxy's trusted proxies set to the NPM VM.
-   `docs/operations.md`: VM preparation (Docker, cgroups, nftables),
    configuration, the two static NPM proxy hosts, DNS records, the
    wildcard certificate via DNS-01, installing and upgrading.

**Done when:** following `docs/operations.md` on a fresh VM gives a
running stack with the firewall active and the probe from 3.3 passing.

### 3.5 First installation (owner)

-   Install on the Proxmox VM following `docs/operations.md`; create
    the NPM proxy hosts and certificate.
-   Deploy a sample app and open it from outside the homelab (e.g. a
    phone on mobile data); open the admin panel through
    `petri.example.com`.

**Done when:** both work from outside, and the probe passes on the
production host.

**Result:** a preview is reachable from outside the homelab.

**Done** (9 November 2026): installed on the Proxmox VM following
`docs/operations.md`, the probe passes there, and a test app was opened
from a phone on mobile data.

## Phase 4 --- Dashboard and gallery

**Goal:** petri. becomes usable as a personal lab notebook and public
showroom: everything the API can do is possible in the admin panel, and
the gallery shows experiments worth trying.

**Starting point:** the API covers projects, deployments (Git and ZIP),
stop/start/delete, live events, build logs and API keys. The web app is
the skeleton from 1.8: gallery list, login, an admin page that counts
projects. Phase 3's installation showed the gap: the first deployment
needed curl.

**Order:** 4.1 settles the look before screens are built; 4.2 gives them
a common base. 4.5 and 4.7 are API work and can come earlier if useful.

### 4.1 Visual design (owner decides)

-   A proposal first, as a living style page at `/admin/styleguide`:
    paper and ink colours, a handwritten accent font, body and monospace
    fonts, experiment numbers (`EXP-007`), date stamps, status stamps
    (ready, building, failed, stopped), labels, buttons, form fields,
    a log view, small hand-drawn sketches (SVG) for empty states.
-   Fonts are self-hosted (no requests to third parties from the
    gallery) and openly licensed.
-   Contrast meets WCAG AA; handwriting only for accents, never for
    content that must be read; usable on a phone.

**Decisions for the owner** (proposals to choose from, made in the
style page):

-   Handwritten font, e.g. *Caveat*, *Kalam* or *Patrick Hand*.
-   Body font: the system font, or e.g. *IBM Plex Sans* with *IBM Plex
    Mono*.
-   How far the notebook look goes: ruled paper, margin line, tape and
    stamps everywhere, or only in headings and the gallery.
-   A dark ("night lab") variant: now, later, or never.

**Chosen** (owner, November 2026):

-   Handwritten font: **Caveat**, for now. **Later:** look for an openly
    licensed handwritten font with connected letters (a real cursive),
    closer to the intended look, and swap it in (one font and the
    `--font-hand` token).
-   Body font: **the system font** (its numbers read better than IBM
    Plex's).
-   **Ruled paper** with a red margin line, behind every page.
-   Night variant: **later**, probably with a look of its own rather
    than the same design in dark colours.

**Done when:** the owner has picked the options and the style page shows
the result; the tokens and components are what 4.2--4.8 use.

### 4.2 Web foundations

-   Shared components from 4.1; layout for the admin area with
    navigation (experiments, API keys, settings) and the signed-in user.
-   Changes go from the browser to the API through the web app's
    `/api/v1` forwarding (one origin, the session cookie, the origin
    check), with the API's error messages shown next to the form.
-   Live updates from the events stream (`EventSource`), reconnecting
    with `Last-Event-ID`; loading, empty and error states everywhere.
-   End-to-end tests with Playwright against the full stack in CI: sign
    in, sign out, a protected page without a session.

**Done when:** the admin layout and the test setup are in place, and a
change made through a form round-trips through the API in an end-to-end
test.

### 4.3 Experiments (projects)

-   Overview: projects as notebook entries with experiment number,
    name, description, current deployment status and last change; the
    newest first.
-   Create and edit: name, description, visibility, the featured
    deployment for the gallery, and the personal notes (Markdown,
    rendered safely; notes never leave the admin area).
-   Delete, explaining the 409 when deployments remain.
-   Experiment numbers are stable: a sequential `number` on projects,
    assigned on creation (migration), not derived from the list order.

**Done when:** a project can be created, described, annotated and
deleted from the browser, and its number never changes.

**Decided:** the number is an identity column: never reused, also not
after a project is deleted (a notebook doesn't renumber its pages).
Existing projects were numbered by creation date in the migration.
Creating a project checks the slug first, so a refused duplicate or a
deployment to an existing project doesn't use up a number; only a
creation that rolls back leaves a gap. Notes are rendered with
`react-markdown` on the server: raw HTML shows as text, unsafe link
targets are dropped. Deleting a project is offered only once its
deployments are deleted, with the reason next to the button. The
end-to-end tests now sign in once and share the session, as the API
allows only five sign-ins a minute.

### 4.4 Deployments

-   Deploy from the dashboard: from Git (repository, ref, directory,
    port, build arguments, lifecycle) and by ZIP upload, with the same
    validation messages as the API.
-   Deployment page: status stamp, preview URL, source and commit,
    lifecycle and expiry, the history as a timeline that updates live,
    and the actions the API offers (stop, start, delete) with
    confirmation for delete.
-   Build log: shown while it is written (incremental, with the
    `x-log-offset` mechanism), kept readable for long logs.

**Done when:** an app can be deployed, followed live, opened, stopped,
started and deleted without leaving the browser, covered by an
end-to-end test.

### 4.5 Runtime logs

-   As proposed in 2.8: the API asks the worker through the job queue
    (`deployment.logs`); the worker writes the app's last lines (up to a
    limit) to the shared logs volume; the API returns them. The API
    still has no Docker access.
-   `GET /deployments/:id/logs?source=runtime`; shown on the deployment
    page, refreshable.

**Done when:** a running app's output is visible in the dashboard, and
a request for a deployment without a container answers clearly.

**Decided:** the worker writes its answer to `logs/runtime/<request>.json`
and publishes an event; the API waits up to 15 s for the event and also
looks for the file each second, since events are best effort. The API
keeps its read-only mount of the logs volume; the worker removes answers
older than five minutes. At most 1,000 lines and 1 MB per answer, times
to the second in UTC. Statuses without a container (not built yet,
deleting, deleted) answer 409 `no_container` without asking the worker;
a worker that doesn't answer gives 503 `worker_unavailable`. The output
is a snapshot, loaded with the page and on **Refresh**, not followed
live.

### 4.6 API keys and settings

-   API keys: list (name, prefix, scopes, last used, expiry), create
    (the key shown once, with a copy button and the curl line to use
    it), revoke.
-   Settings, read-only: admin and preview URLs, version (commit), and
    the limits in force (upload size, build timeout, container limits).
    Changing settings stays in `.env`.

**Done when:** keys can be managed without curl, and a revoked key
stops working (end-to-end test).

### 4.7 Preview images

-   `PUT /projects/:id/image` (owner and `deploy:update`): PNG, JPEG or
    WebP, at most 2 MB, checked by content (magic bytes and dimensions),
    not by name or declared type; stored in the uploads volume.
-   `GET /gallery/:slug/image`: public, only for projects shown in the
    gallery, served with a fixed content type, `nosniff` and caching.
-   Upload and remove it on the project page.

**Done when:** an image appears on the gallery card, and files that
aren't images, or are too large, are refused (tests with crafted files).

### 4.8 Public gallery

-   Cards: preview image (or a sketch as placeholder), name,
    description, branch or version, status, last update, and **Try it**
    opening the preview URL.
-   Responsive, fast without JavaScript (server-rendered), page title and
    link previews (Open Graph, using the preview image).
-   Shows only what the API's gallery response contains; a test makes
    sure notes, sources and internal details never reach the page.

**Done when:** from a phone outside the homelab, the gallery shows the
featured experiments with images, and **Try it** opens them.

**Result:** petri. is usable as a personal lab notebook and public
showroom, without curl.

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
