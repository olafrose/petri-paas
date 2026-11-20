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

**Decided:** the settings come from a new `GET /settings` (scope
`deploy:read`, so coding assistants can check limits before deploying).
The limits are the constants the build engine and runtime enforce,
exported from those packages, so the page can't drift from what is
enforced. The version is the commit, passed into the API image by CI
(`PETRI_COMMIT`); local builds show "development build". New keys get
read, create and update by default; delete is opt-in.

### 4.7 Preview images

-   `PUT /projects/:id/image` (owner and `deploy:update`): PNG, JPEG or
    WebP, at most 2 MB, checked by content (magic bytes and dimensions),
    not by name or declared type; stored in the uploads volume.
-   `GET /gallery/:slug/image`: public, only for projects shown in the
    gallery, served with a fixed content type, `nosniff` and caching.
-   Upload and remove it on the project page.

**Done when:** an image appears on the gallery card, and files that
aren't images, or are too large, are refused (tests with crafted files).

**Decided:** the request body is the file itself (`curl --data-binary
@shot.png`), and its declared type is ignored. A small parser reads the
PNG, JPEG or WebP header for the type and size (each side 16 to 8192
pixels), with no image library; it is tested against files encoded by
Chromium and against crafted ones. Images are never re-encoded: they're
served with the type found on upload, `nosniff`, and a content security
policy that allows nothing, and are cached for five minutes, so a hidden
experiment's image doesn't linger. Their URLs carry the upload time, so
a new image shows at once. The admin page loads the image through
`GET /projects/:id/image` (also for private projects); the gallery's
route serves only what the gallery shows. The card shows the image
cropped to 1200 × 630; the rest of the card is 4.8.

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

**Decided:** each experiment in the gallery also gets its own page,
`/experiments/<slug>` (from `GET /gallery/:slug`, public, the same
fields and conditions), so a shared link previews that experiment with
its image; the gallery's own preview uses the newest image. Link
previews need absolute URLs: the web container now gets `PUBLIC_URL`
(already in `.env`). Both pages work without JavaScript, which the
end-to-end test checks, along with **Try it** opening the app and the
public pages containing no notes or ids.

**Result:** petri. is usable as a personal lab notebook and public
showroom, without curl.

## Phase 5 --- Lifecycle and automation

**Goal:** coding assistants get access without the owner copying keys
around, and cultures live as long as they should.

**Starting point:** the admin panel calls projects *experiments* but
still says *deployments*, and in places *projects*. A coding assistant
needs a key the owner creates in the admin panel and pastes into it.

**Order:** 5.1 settles the words that 5.2's screens use. 5.4 comes
next: temporary cultures pile up until it exists. 5.5 builds on its
expired state, and 5.6 on both. 5.7 is small and can come anytime. 5.8
is last: it starts with a spike whose outcome may change it.

### 5.1 Cultures (deployments)

-   In everything a person reads, a deployment is now a *culture*: an
    experiment grows cultures. That covers the admin panel, the
    gallery, page titles and confirmations. Screens that still say
    *project* say *experiment*.
-   Wording: **New culture**, **Grow culture** (the deploy button;
    *Start* stays the action for a stopped culture), **Featured
    culture**, "Delete this culture?". Statuses and the stop, start and
    delete actions keep their names.
-   The API keeps its names: paths, fields, scopes (`deploy:*`), events,
    error messages and the OpenAPI document; so do the code and the
    database. The API key page explains each scope in the new words.
-   Admin URLs follow the words (`/admin/cultures/:id`,
    `/admin/experiments/:id`); the old paths redirect.
-   Architecture section 13 notes which words the interface uses for
    which API resource. The README and the operations guide describe
    the API and keep its words.

**Done when:** no page of the web app says *deployment* or *project*
(an end-to-end test walks the admin pages), and the API is unchanged.
Messages the API sends, shown next to form fields, keep the API's
words.

**Decided:** the admin pages moved to `/admin/experiments/…` and
`/admin/cultures/…` (`/admin/cultures/new` for the form); the old paths
redirect, and the form still reads `?project=` from old links. A list
without cultures says "No living cultures." The end-to-end check leaves
out logs and the history, which show what builds, apps and the worker
wrote. The React components and test helpers keep their code names
(`DeploymentList`, `ProjectForm`).

### 5.2 Access requests for coding assistants

A coding assistant asks for access; the owner grants or denies it in
the admin panel; the assistant then receives an API key. The flow
follows the OAuth device authorization grant (RFC 8628), without the
rest of OAuth.

-   `POST /access-requests` (public): the assistant names itself (e.g.
    "Claude Code on laptop"), asks for scopes and may give a reason.
    The answer holds a short code (`WXYZ-1234`), the admin link to
    review it, a secret poll token, the expiry (15 minutes) and the
    polling interval.
-   `POST /access-requests/token` (public): with the poll token, answers
    `pending`, `denied` or `expired`; once granted, the API key, exactly
    once. Only the poll token gets the key; the short code only lets the
    owner tell requests apart.
-   Admin panel, **Access requests**: open requests with name, scopes,
    reason, code, address and time. **Grant** (scopes can be narrowed,
    an expiry chosen) or **Deny**. Owner only.
-   A granted request becomes an ordinary API key: same scopes, expiry,
    revocation and "last used", listed on the API keys page with where
    it came from. No new scopes.
-   The public endpoints are limited: a rate limit per address, at most
    10 open requests, and the poll interval enforced (`slow_down`).
    Poll tokens are stored hashed, like keys.

**Done when:** an assistant can go from nothing to a working key with
the owner only clicking **Grant** (end-to-end test); a denied or
expired request never yields a key; a poll token works only once after
the grant.

**Decided:** the key is created when the assistant collects it, so it
is never stored; granting records the scopes and the key's lifetime,
and gives the assistant another 15 minutes to collect. Codes are eight
consonants (`WXYZ-BCDF`, RFC 8628's alphabet); the review link carries
the code, and the page marks the matching request. Limits are counted
in the database: five requests per address in ten minutes (the address
as for sign-in, through `TRUST_PROXY`), ten open at a time, polls at
most every five seconds (429 `slow_down`). A second collection answers
410 `already_collected`. Expired requests are removed a day later;
collected ones stay, as the key's `accessRequestId` points to them.
Granting and denying are owner only, like key management.

### 5.3 A guide for coding assistants

-   `GET /guide` (public): a short how-to in Markdown, written for
    coding assistants, read in full before they start. The web app also
    serves it as `/llms.txt`.
-   Contents: what petri. is (experiments grow cultures; a culture is a
    preview at its own address; the gallery is public); getting access
    (5.2: show the user the code and link, poll, keep the key and never
    print it); growing a culture from Git or a ZIP (Dockerfile, port,
    experiment slug and name); following it (status, events, the build
    log on failure, `url` once ready); ground rules (temporary by
    default, delete only what you created, check `GET /settings` before
    uploading, ask the user before making anything public or featured);
    and the OpenAPI document, with the API's names next to the
    interface's (*deployment* = culture, *project* = experiment).
-   Filled in from the running instance: the real public URL and preview
    domain, so examples work as written. Limits stay behind
    `GET /settings`; the guide shows nothing the gallery doesn't.
-   The API keys page and the 401 answer point to the guide.

**Done when:** an assistant given only petri.'s address can find the
guide, request access and grow a culture by following it; a test makes
sure every endpoint the guide names exists with the access it claims.

**Decided:** the guide is a template in the API (`guide.ts`), filled in
once at startup with `PUBLIC_URL` and the preview domain; the web app
forwards `/llms.txt` to it. Its endpoint table is a list in code; tests
check each entry against the registered routes and their access rules,
and every API address in the text against the routes. The examples use
`<…>` placeholders for what the assistant fills in (repository,
experiment slug, culture name). Errors gained an optional
`help` link: 401 answers point to the guide, so the admin panel's
messages stay as they were. The API keys page points to `/llms.txt`.

### 5.4 Expiry

Temporary cultures get an expiry time today (`expiresAt`, 48 hours by
default), but nothing acts on it: they run until deleted.

-   A cleanup job in the worker (a pg-boss schedule, every five minutes)
    finds temporary cultures past `expiresAt` that are ready, stopped or
    failed. Each becomes `expired` first, so the edge proxy stops
    routing it, then its container, network and image are removed. The
    history, build logs and the uploaded archive stay, so it can be
    grown again (5.5).
-   `PATCH /deployments/:id` (scope `deploy:update`) changes the
    lifecycle: extend a temporary culture (`ttlHours`, counted from
    now, at most 720), or make it permanent, or temporary again. Not
    for cultures that are expired, deleting or deleted.
-   Admin panel: the culture page shows the time left, with **Extend**
    (another 48 hours) and **Keep** (permanent); the experiment list
    marks cultures that expire within a day. The note "once expiry is
    implemented (phase 5)" goes.
-   The guide mentions extending, and the endpoint table gains `PATCH`.

**Done when:** a temporary culture past its time stops answering
within five minutes and is shown as expired with its history intact;
an extended or permanent one keeps running (integration tests with the
time moved, end-to-end test for the buttons).

**Decided:** the job (`deployment.expire`) also skips a culture with a
build queued or running, such as a ready one growing a new batch; the
next run takes it. Expiring commits first; removing the app follows,
and a removal that fails is tried again by the next run (the expired
culture still records a container, image or route). The removal is the
delete job's, minus the uploads (`removeApp`). `PATCH` takes the
creation form's `lifecycle` (`{"mode": "temporary", "ttlHours": …}`
or `{"mode": "permanent"}`) and records the change in the history
("Extended: expires in 48 hours"). A redeploy of a culture past its
time gives it another 48 hours, or it would expire again as soon as it
is ready. The admin panel shows the time left rounded ("5 hours", "2
days"); the mark in lists reads "expires in …". A permanent
culture offers **Make temporary** (48 hours), so the owner can switch
either way.

### 5.5 Redeploy

Today a new version means a new culture. Coding assistants iterate:
push, rebuild, look, repeat.

-   `POST /deployments/:id/redeploy` (scope `deploy:update`): builds the
    culture again from its source, as a new build in its history. Git:
    the same ref, fetched again (a branch picks up new commits); an
    optional `ref` changes it. Allowed from ready, stopped, failed and
    expired, as the state machine already says.
-   `POST /deployments/:id/upload` (scope `deploy:update`): the same
    with a new ZIP archive. It replaces the old one once its version is
    live, so the running version never loses its source.
-   Admin panel: **Redeploy** on the culture page (the action the API
    already lists); the build history lists every build with its
    commit and result.
-   The guide describes the loop: push or zip, redeploy, follow,
    look.

**Decided** (owner, November 2026): the old version keeps answering
while the new one builds.

-   A ready culture stays `ready` during a redeploy; the new build has
    its own status (builds already have one), and the culture page
    shows "growing a new batch". The new app starts next to the old
    one on the culture's network, under its own name.
-   Once the new app passes its health check, the route switches to it
    and the old app and its image are removed. Until then, each build
    keeps its own image.
-   A failed build or health check removes only the new app: the old
    version keeps running, the culture stays `ready`, and its history
    says why the new version failed (with the build log, as now).
-   A culture that isn't running (stopped, failed, expired) has nothing
    to keep: a redeploy takes the usual path through `queued`.
-   One build at a time: a redeploy while one is running answers 409.

**Done when:** a pushed change shows up at the same address after
**Redeploy**, from the admin panel and through the API, and an expired
culture can be grown again.

**Decided** (building it): each build records what it builds
(`builds.source`); a new ref or archive becomes the culture's source
once its build is live, and a failed build's archive is removed. The
new app runs as `petri-<id>-next`; at the switch, under the culture's
lock, the route points to it, the old app goes, and the new one is
renamed `petri-<id>`, so everything else keeps finding it by that name.
The steps of a new batch are history entries of type `build`, which
the culture page follows live. Stopping or deleting the culture cancels
its new batch; if Docker fails between removing the old app and
renaming the new one, the culture fails rather than guess. `GET
/deployments/:id/builds` lists the builds for the page's history. In
the admin panel, a ZIP culture's **Redeploy** takes an optional new
archive.

### 5.6 Recovery

What happens when things go wrong outside a request: the worker dies
mid-build, the host restarts, an app crashes for good, or a cleanup
step fails ("Reconciliation (phase 5) catches leftovers" in
`deployment-run.ts`).

-   A reconciliation job in the worker (every five minutes, and once at
    startup) compares the database with Docker, using the containers',
    networks' and images' petri. labels:
    -   A culture stuck in a build step longer than its job can live
        (30 minutes) becomes `failed`: "interrupted".
    -   A ready culture whose container is gone, or keeps restarting,
        becomes `failed`, with its last output in the history.
    -   Containers, networks and images with no culture that should
        have them are removed (leftovers from failed cleanups).
-   Everything the job changes is written to the culture's history; a
    summary goes to the worker's log.
-   Docker's `unless-stopped` restarts apps after a host restart, and
    the route sync restores routes; an end-to-end check confirms it.

**Done when:** integration tests that kill the worker mid-build, remove
a container behind petri.'s back and leave leftovers each end with the
database and Docker agreeing again.

**Decided** (building it): the job is `deployment.reconcile`. A build
step's start is the culture's last status change; `queued` is left
out, since a long queue isn't stuck. A new batch whose build has run
for 30 minutes fails too, and the ready version stays. An app that
isn't running fails only if it still isn't at the next run, five
minutes later: right after a host restart Docker may not have started
it yet. A container that is gone fails the culture at once. A crashed
app's container is stopped and kept, for its logs; the culture page
shows its last output under the history entry. Images carry no labels
(BuildKit makes them), so they are found by their `petri/<culture>:<build>`
tag. Resources of cultures the database doesn't know are logged, not
removed: on the development machine, test runs and the dev worker share
one Docker with databases of their own. Repairs that don't change the
status are history entries of type `recovery`. A real reboot can't be
part of a test run: the end-to-end check lets an app exit by itself
(Docker starts it again) and restarts the edge proxy's container (the
route sync restores its routes).

### 5.7 API polish for coding assistants

Small things that save an assistant requests and guesswork:

-   `GET /api-keys/current` (any key): the calling key's name, scopes
    and expiry, so an assistant can check what it may do before trying.
-   `GET /deployments?project=<slug>`: assistants know the experiment's
    slug, not its id.
-   `GET /deployments/:id?wait=<seconds>` (at most 60): answers as soon
    as the status changes, instead of the assistant polling every few
    seconds.
-   The guide uses all three.

**Done when:** following the guide, an assistant needs one request to
check its key, and one request per status change to follow a build.

### 5.8 Buildpacks

Apps without a Dockerfile: detected and built with Cloud Native
Buildpacks (Paketo), as architecture section 8.3 plans.

-   `build.strategy`: `auto` (a Dockerfile if there is one, else
    buildpacks), `dockerfile` or `buildpacks`. The build log says which
    was used and why.
-   Buildpack images listen on `$PORT`: petri. sets `PORT` (8080 unless
    `build.port` says otherwise) and uses it for the health check.
-   **Spike first:** `pack` needs a Docker daemon to run the builder,
    and the worker only has the restricted socket proxy and BuildKit.
    Giving builds the Docker daemon would undo the build isolation from
    2.5 and 3.3. To try instead: Paketo's lifecycle (`creator`) run
    inside BuildKit from a generated build file, exporting an image
    archive, as Dockerfile builds do now. The spike decides, with the
    owner, before the task is built.
-   The builder image (around 1 GB) is pulled once and kept; the first
    buildpack build is slow, the next ones reuse its layers.

**Done when:** a Node.js app and a Python app without a Dockerfile grow
into cultures, under the same limits and network rules as Dockerfile
builds.

### Not in this phase

-   Runtime environment variables (architecture 8.3): apps that need
    settings or secrets. Secrets need the storage and encryption review
    of phase 6, so both come there, together.

## Phase 6 --- Hardening (outline)

-   Move builds to a separate VM.
-   Runtime environment variables and secrets for apps (deferred from
    phase 5), with the secret encryption review.
-   Apps with several containers, from a Compose file (below). Needs the
    runtime settings first.
-   OIDC configuration guide (e.g. Authentik).
-   Backup and restore procedures.

### Apps with several containers (outline)

Some apps are several services: e.g. CMMS-Home is a Next.js `web`, a
.NET `api` and PostgreSQL (`db`), described in a `docker-compose.yml`.
petri. stays a lab and a showroom, not a hosting platform: such a
culture is for trying a version and showing it, and its data may be
lost.

-   petri. reads the Compose file as a description and creates the
    containers itself, each with the same fixed security settings as
    today. It never runs `docker compose`: that needs the whole Docker
    daemon, which the worker deliberately lacks, and a Compose file can
    ask for anything (privileged, host network, host paths, the Docker
    socket).
-   Accepted: `build` (context, dockerfile, args), `image` (pulled),
    `command`, `entrypoint`, `environment` with literal values,
    `depends_on` (start order) and `healthcheck`. Refused, with a clear
    message: `privileged`, `network_mode`, `pid`, `ipc`, `cap_add`,
    `devices`, `security_opt`, host paths, `env_file` and `${VAR}`.
    Host ports are ignored.
-   Each service runs as `petri-<id>-<service>` on the culture's network,
    reachable by its service name (`db:5432` works as under Compose).
-   One service is public: it gets the route and the health check. It
    is named in an `x-petri` section, or else is the one service no
    other depends on.
-   Storage is temporary: named volumes and an `x-petri` list of paths
    become per-culture scratch space, owned by the user the image runs
    as, gone when the culture is deleted. Durable data is out of scope.
-   Settings that are not in the file (e.g. the first administrator's
    password) come from the runtime settings of this phase.
-   Limits: a memory budget per culture across its services, shown in
    `GET /settings`.
-   Redeploy rebuilds the services built from source and keeps services
    with storage (the database) running: two databases on one volume
    would corrupt it.
-   To check early: PostgreSQL's image changes its data directory's
    owner and permissions as root before switching users, which may need
    a capability petri. drops today; and Docker volumes have no size
    limit, so scratch space needs one of its own.

**Done when:** CMMS-Home grows from its repository, with at most an
`x-petri` section added to its Compose file, and its web interface
works at the preview address; a redeploy keeps the database's data.
