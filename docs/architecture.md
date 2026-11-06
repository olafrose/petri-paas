# petri. --- Architecture & Technical Design

**Version:** 0.2\
**Date:** 6 November 2026\
**Status:** Architecture proposal --- revised for a separate NPM VM and
a petri.-owned edge proxy\
**Project type:** Self-hosted, open-source application preview and
experiment platform

------------------------------------------------------------------------

## 1. Product vision

**petri. is a personal experiment lab and public showcase for
applications, prototypes and mockups.**

It allows its owner to publish applications from Git repositories or ZIP
uploads, make them accessible through public preview URLs and try them
from anywhere --- including a phone.

The platform is designed around two complementary experiences:

-   **Personal lab notebook:** Create, manage, inspect and document
    experiments.
-   **Public showcase:** Browse published experiments and open them
    directly to interact with the applications.

The platform is not intended to become a general-purpose hosting
provider or a full production deployment platform. Its primary purpose
is to make work in progress easy to access, demonstrate and test.

### 1.1 Product principles

1.  **Try, not just view:** A preview is a real, interactive
    application.
2.  **Publish quickly:** Getting a prototype online should require as
    little configuration as possible.
3.  **Self-hosted by design:** Application source code, deployment
    metadata and runtime remain under the operator's control.
4.  **Public by default:** Published previews are accessible through
    public URLs unless explicitly configured otherwise.
5.  **Temporary and permanent:** Experiments can expire automatically or
    remain online.
6.  **Keep the notebook:** Build history, deployment history and
    experiment notes remain useful even after a preview stops.
7.  **Do not replace existing infrastructure:** Existing Nginx Proxy
    Manager remains the public reverse proxy and TLS endpoint.

------------------------------------------------------------------------

## 2. Scope

### 2.1 MVP features

-   Create and manage logical projects.
-   Deploy from a Git repository.
-   Upload a ZIP archive and deploy its contents.
-   Build applications using a Dockerfile.
-   Automatically detect common application types and use buildpacks
    when appropriate.
-   Configure the internal HTTP port.
-   Create a public preview URL for each deployment.
-   Route preview traffic from the existing Nginx Proxy Manager through
    a petri.-owned edge proxy.
-   Start, stop, restart, redeploy and delete deployments.
-   Support temporary deployments with configurable expiration.
-   Support permanent deployments.
-   Display build and runtime logs.
-   Show deployment status and lifecycle information.
-   Provide a public gallery of active experiments.
-   Provide an API for coding assistants and automation clients.
-   Generate and retain deployment events.

### 2.2 Not in the initial scope

-   Multi-tenant SaaS operation.
-   Billing, subscriptions or quotas for external customers.
-   Kubernetes orchestration.
-   Production-grade high availability.
-   A general-purpose source-code hosting system.
-   Automatic provisioning of databases and arbitrary dependent
    services.
-   A complex user and role management system.

These capabilities may be considered later, but should not complicate
the first implementation.

------------------------------------------------------------------------

## 3. System context

### 3.1 Existing infrastructure

Nginx Proxy Manager (NPM) is already part of the homelab. It runs on its
own VM, separate from the petri. host, and remains responsible for:

-   Receiving public HTTP and HTTPS traffic.
-   TLS termination.
-   Forwarding requests to the right internal host.
-   Managing proxy host configurations and certificates.

NPM is configured once, by hand, with two static proxy hosts:

  Proxy host            Forwards to
  --------------------- ---------------------------------------------
  `petri.example.com`   petri. web interface on the petri. host
  `*.app.example.com`   petri. edge proxy on the petri. host

petri. does not create, change or remove NPM proxy hosts at runtime.
Routing individual previews is handled by the petri. edge proxy (see
section 10).

petri. must not access or modify NPM's internal database or API, and
holds no NPM credentials.

### 3.2 Domain architecture

Example domain structure:

  Purpose              Domain
  -------------------- --------------------------------------
  Main application     `petri.example.com`
  Preview deployment   `experiment-name.app.example.com`
  Additional preview   `another-experiment.app.example.com`

DNS records:

-   `petri.example.com` points to the public IP.
-   `*.app.example.com` points to the same public IP.

The TLS certificate must cover both:

-   `petri.example.com`
-   `*.app.example.com`

A wildcard certificate for `*.example.com` alone does not cover
`experiment-name.app.example.com`.

Use DNS-01 validation for the wildcard certificate. Certificate
provisioning and renewal remain the responsibility of NPM or the
established certificate-management setup.

The domain names are configuration, not hard-coded application
constants.

------------------------------------------------------------------------

## 4. High-level architecture

The system consists of a web interface, an API, asynchronous workers,
persistent storage, a build environment and the existing infrastructure
services.

### 4.1 Logical architecture

``` mermaid
flowchart TB
    User["Owner / Browser / Coding Assistant"]

    subgraph Petri["petri. Control Plane"]
        Web["Web UI"]
        API["REST API"]
        Auth["Session / API Key Authentication"]
        Orchestrator["Deployment Orchestrator"]
        Worker["Background Worker"]
        DB[("PostgreSQL + pg-boss")]
    end

    subgraph Build["Build Environment"]
        Source["Git / ZIP Source"]
        BuildKit["BuildKit"]
        Buildpacks["Buildpack Provider"]
        Image["Container Image"]
    end

    subgraph Runtime["Runtime Environment"]
        Edge["petri. Edge Proxy"]
        Docker["Docker Engine"]
        Containers["Application Containers"]
    end

    NPM["Nginx Proxy Manager (separate VM)"]
    Internet["Public Internet"]

    User --> Web
    User --> API
    Web --> API
    API --> Auth
    Auth --> Orchestrator
    Orchestrator --> DB
    DB --> Worker
    Worker --> Source
    Worker --> BuildKit
    Worker --> Buildpacks
    BuildKit --> Image
    Buildpacks --> Image
    Image --> Docker
    Docker --> Containers
    Worker --> Edge
    NPM --> Web
    NPM --> Edge
    Edge --> Containers
    Internet --> NPM
    API --> DB
```

The diagram represents logical responsibilities, not necessarily
separate physical machines in the MVP.

### 4.2 Main components

  -----------------------------------------------------------------------
  Component                           Responsibility
  ----------------------------------- -----------------------------------
  Web UI                              Dashboard, experiment gallery,
                                      project details and settings

  REST API                            Authentication, validation and
                                      public application interface

  Deployment Orchestrator             Coordinates deployment state
                                      transitions

  Worker                              Executes builds, deployment actions
                                      and cleanup jobs

  Build Engine                        Retrieves source and produces
                                      container images

  Runtime Manager                     Creates, starts, stops and removes
                                      containers

  Proxy Manager                       Registers and removes preview
                                      routes on the edge proxy

  Edge Proxy                          Routes `*.app` hostnames to
                                      application containers

  PostgreSQL                          Persistent application data, job
                                      queue (pg-boss) and change
                                      notifications

  Docker Engine                       Runs application containers

  NPM (separate VM)                   Public reverse proxy and TLS
                                      termination
  -----------------------------------------------------------------------

The frontend, API and worker should be separate deployable services,
even if they initially run on the same host.

------------------------------------------------------------------------

## 5. Technology stack

The implementation uses TypeScript on Node.js across the application.
The reasons for each choice are recorded in section 5.2.

  -----------------------------------------------------------------------
  Layer                   Technology              Purpose
  ----------------------- ----------------------- -----------------------
  Frontend                Next.js + TypeScript    Web interface

  Backend                 Fastify + Zod           REST API and
                                                  orchestration

  Database                PostgreSQL              Persistent state

  ORM                     Drizzle                 Database access and
                                                  migrations

  Queue                   pg-boss (on             Background jobs
                          PostgreSQL)             

  Authentication          Better Auth             Admin login, sessions,
                                                  later OIDC

  Edge proxy              Caddy                   Preview routing

  Container runtime       Docker Engine API       Container lifecycle
                          (dockerode, via a       
                          socket proxy)           

  Image building          BuildKit (standalone    Dockerfile builds
                          buildkitd)              

  Automatic builds        Paketo Buildpacks or    Applications without
                          another compatible      Dockerfiles
                          provider                

  API documentation       OpenAPI / Swagger       API contract

  Streaming updates       Server-Sent Events      Deployment events and
                          (SSE)                   live status
  -----------------------------------------------------------------------

### 5.1 Architectural principle: adapters

Infrastructure-specific implementations must be isolated behind
interfaces.

This prevents the application from becoming tightly coupled to a
specific proxy, builder or container runtime.

Initial interfaces:

``` ts
interface BuildProvider {
  detect(source: BuildSource): Promise<boolean>;

  build(
    source: BuildSource,
    options: BuildOptions
  ): Promise<BuildResult>;
}

interface RuntimeProvider {
  create(options: ContainerOptions): Promise<ContainerResult>;
  start(containerId: string): Promise<void>;
  stop(containerId: string): Promise<void>;
  remove(containerId: string): Promise<void>;
  getStatus(containerId: string): Promise<ContainerStatus>;
}

interface ProxyProvider {
  createRoute(options: ProxyRouteOptions): Promise<ProxyRouteResult>;
  removeRoute(routeId: string): Promise<void>;
  getRoute(routeId: string): Promise<ProxyRouteStatus>;
}
```

The first implementations are:

-   `DockerRuntimeProvider`
-   `BuildKitProvider`
-   `BuildpackProvider`
-   `CaddyEdgeProxyProvider`

### 5.2 Stack rationale

**TypeScript everywhere.** One language for web, API and worker lets
`packages/contracts` define request and response shapes once and share
them. The Docker Engine API has a mature Node client (dockerode).

**Fastify + Zod instead of NestJS.** Zod schemas in `packages/contracts`
serve as runtime validation, TypeScript types and the OpenAPI document
from a single source. NestJS's main benefit, dependency injection, is
not needed: the adapters in 5.1 are passed in through constructors.
Fastify also starts faster and uses less memory, which matters on the
4 GB development machine. Trade-off: less built-in structure, so the
module layout is enforced by convention.

**Next.js for the web app.** The public gallery is server-rendered, so
it loads fast on phones and produces proper link previews when a preview
is shared. The gallery and the admin panel live in one app. Trade-off:
the Next.js dev server is the heaviest process in development.

**PostgreSQL + pg-boss instead of Redis + BullMQ.** Job volume is tiny
(a few deployments per day), so a separate Redis adds a stateful service
to run, secure and back up without a real benefit. pg-boss stores jobs
in PostgreSQL, which means a deployment record and its job are created
in the same transaction and can never get out of sync. pg-boss provides
retries, cron schedules (cleanup, reconciliation) and singleton jobs.
Live status updates use PostgreSQL `LISTEN/NOTIFY` and are forwarded to
the browser as SSE.

**Drizzle instead of Prisma.** The schema is plain TypeScript with no
code-generation step, queries stay close to SQL, and it shares the same
`pg` connection pool as pg-boss, which is what makes the shared
transaction above straightforward.

**Better Auth for the admin panel.** Login and session handling are
security-critical and should not be hand-written. Better Auth provides
password login with server-side sessions in PostgreSQL now, and generic
OIDC (Authentik, Authelia, etc.) later through configuration only. The
public gallery requires no login. Coding assistants use separately
implemented scoped API keys (section 12.4). Verified in a spike in
task 1.6 before other code depended on it.

**Caddy as the edge proxy instead of Traefik.** Traefik's convenient
mode discovers containers through the Docker socket, and the edge proxy
is the one component reachable from the LAN, so it must not hold the
socket. Caddy is configured through its admin API instead: petri. pushes
routes, and the full configuration can be regenerated from the database
at any time. The admin API listens only on an internal network.

**Docker socket proxy.** Only the worker talks to Docker, and only
through a socket proxy that allows the API calls it needs. This limits
the damage of a compromised worker (section 15).

**Standalone buildkitd.** Running BuildKit as its own service, rather
than through the host's Docker daemon, keeps untrusted builds apart from
the runtime and allows moving builds to a separate VM later (section
16.2) without code changes.

**Tooling.** pnpm workspaces for the monorepo, Biome for linting and
formatting (one fast tool instead of ESLint and Prettier), Vitest for
tests, GitHub Actions for CI. Type-checking uses TypeScript 7, the
native compiler, which is much faster and lighter than earlier versions;
a package whose tooling still needs the TypeScript 6 compiler API can
pin TypeScript 6 locally.

------------------------------------------------------------------------

## 6. Repository structure

Use a monorepo to keep shared types, API contracts and infrastructure
adapters consistent.

``` text
petri/
├── apps/
│   ├── web/                  # Next.js frontend
│   ├── api/                  # Fastify REST API
│   └── worker/               # Background job processing
│
├── packages/
│   ├── contracts/            # Shared API and domain types
│   ├── database/             # Drizzle schema and migrations
│   ├── build-engine/         # Build orchestration and providers
│   ├── runtime/              # Container runtime abstraction
│   ├── proxy-manager/        # Edge proxy route management
│   ├── deployment-core/      # Deployment state machine
│   └── config/               # Shared configuration
│
├── infrastructure/
│   ├── docker/
│   ├── compose/
│   └── examples/
│
├── docs/
│   ├── architecture.md
│   ├── api.md
│   ├── security.md
│   └── operations.md
│
├── docker-compose.yml
├── pnpm-workspace.yaml
└── README.md
```

------------------------------------------------------------------------

## 7. Domain model

A project and a deployment are different entities.

A **Project** represents a logical application or experiment. A
**Deployment** represents one concrete running or previously running
instance of that project.

For example:

-   Project: `Dashboard Concept`
-   Deployment: `main`
-   Deployment: `feature/new-navigation`
-   Deployment: `mockup-v2`

This separation allows one project to have multiple previews without
duplicating project metadata.

### 7.1 Core entities

#### Project

  Field         Description
  ------------- ---------------------------
  id            Unique identifier
  name          Display name
  slug          Stable project identifier
  description   Short explanation
  notes         Personal lab notes
  visibility    Public or private
  created_at    Creation timestamp
  updated_at    Last modification

#### Deployment

  Field              Description
  ------------------ ---------------------------------------------
  id                 Unique identifier
  project_id         Parent project
  name               Deployment display name
  subdomain          Unique preview subdomain
  source_type        Git or ZIP
  source_reference   Repository and revision or upload reference
  status             Current deployment status
  image_id           Built image reference
  container_id       Runtime container reference
  route_id           Edge proxy route reference
  internal_port      Application HTTP port
  lifecycle_mode     Temporary or permanent
  expires_at         Expiration timestamp, nullable
  created_at         Creation timestamp
  updated_at         Last modification

#### Build

  Field           Description
  --------------- -------------------------
  id              Unique identifier
  deployment_id   Related deployment
  status          Build status
  provider        Dockerfile or buildpack
  started_at      Start timestamp
  finished_at     Completion timestamp
  image_id        Resulting image
  log_reference   Build log reference
  error_message   Failure summary

#### Additional entities

-   `ApiKey`
-   `DeploymentEvent`
-   `EnvironmentVariable`
-   `DeploymentTemplate`

Environment variables and secrets must be stored separately from
ordinary project metadata.

### 7.2 Deployment statuses

``` text
QUEUED
  ↓
CLONING
  ↓
BUILDING
  ↓
DEPLOYING
  ↓
HEALTH_CHECK
  ↓
READY
```

Failure and lifecycle states:

``` text
FAILED
STOPPED
EXPIRED
DELETING
```

The state machine must reject invalid transitions. For example, a
deployment cannot become `READY` before the container has passed its
health check.

------------------------------------------------------------------------

## 8. Source and build system

petri. supports two source types.

### 8.1 Git repositories

The user supplies:

-   Repository URL
-   Branch, tag or commit
-   Optional build directory
-   Optional build configuration
-   Optional environment variables

The build worker checks out a fixed revision before building. This
ensures that a deployment can be traced back to the exact source version
used.

Private repository authentication must be supported through securely
stored credentials or deploy keys. The exact authentication methods for
the MVP remain a product decision.

### 8.2 ZIP uploads

The user uploads a ZIP archive containing the application source.

The API must:

-   Enforce upload size limits.
-   Validate archive structure.
-   Reject path traversal entries.
-   Reject unsafe extraction paths and archive entries.
-   Extract into an isolated temporary workspace.
-   Clean up temporary files after the build.

### 8.3 Build strategy

The build engine supports:

1.  Dockerfile builds.
2.  Automatic build detection and buildpacks.

**Priority:** If a Dockerfile exists, use it by default. Otherwise,
attempt buildpack detection.

The user may override automatic detection and configure:

-   Build directory
-   Build strategy
-   Internal HTTP port
-   Optional start command, where supported
-   Build-time arguments
-   Runtime environment variables

Automatic port detection may be helpful, but must not be the only way to
configure the application port.

### 8.4 Build lifecycle

``` text
Receive source
    ↓
Validate source
    ↓
Create isolated workspace
    ↓
Clone repository / extract ZIP
    ↓
Detect build strategy
    ↓
Build container image
    ↓
Store build result and logs
    ↓
Create runtime container
```

Build logs should be streamed to the dashboard where practical and
retained for later inspection.

------------------------------------------------------------------------

## 9. Runtime and networking

### 9.1 Container runtime

Each deployment runs as a separate application container.

The runtime manager is responsible for:

-   Creating containers.
-   Applying resource limits.
-   Configuring networks.
-   Setting environment variables.
-   Starting and stopping containers.
-   Collecting health and status information.
-   Removing containers and associated resources.

Application containers must not receive access to the Docker socket.

### 9.2 Internal networking

Application containers must not publish host ports.

NPM runs on a separate VM, so it cannot join petri.'s Docker networks.
The edge proxy is the only petri. component that listens for preview
traffic from outside the host:

``` text
NPM VM  --(LAN, HTTP)-->  petri. host: edge proxy  -->  Docker network  -->  container:port
```

-   The edge proxy publishes a single port, bound to an interface the
    NPM VM can reach. A host firewall allows only the NPM VM to connect
    to it.
-   The web interface port is exposed the same way, for NPM's
    `petri.example.com` proxy host.
-   Each deployment gets its own Docker network. The edge proxy joins
    each deployment network; deployments cannot reach each other.
-   The edge proxy answers unknown hostnames with an error and never
    falls through to another service.
-   The edge proxy trusts `X-Forwarded-*` headers only from the NPM VM.
-   The same applies to the web interface: the API takes the client
    address for login rate limiting from `X-Forwarded-For`, which NPM
    sets and the web app passes on. If anything other than NPM could
    reach the web port, it could choose its own address and evade the
    limit.

Traffic between NPM and the edge proxy is plain HTTP on the LAN in the
MVP. Encrypting this hop is a later hardening option.

### 9.3 Health checks

A deployment is only marked `READY` after a successful health check.

The MVP should support:

-   Configurable internal port.
-   HTTP readiness check.
-   Configurable startup grace period.
-   Retry count and timeout.
-   Clear failure reason when the application does not become healthy.

------------------------------------------------------------------------

## 10. Preview routing

Preview routing uses two reverse proxy layers:

1.  **NPM** (separate VM) is the only public entry point. It terminates
    TLS and forwards all of `*.app.example.com` to the petri. edge
    proxy. Its configuration is static.
2.  **The petri. edge proxy** (on the petri. host) routes each preview
    hostname to the matching application container.

Example:

``` text
demo.app.example.com
        ↓
Nginx Proxy Manager (TLS, wildcard proxy host)
        ↓
petri. edge proxy (Host: demo.app.example.com)
        ↓
Application container:3000
```

Reasons for this design:

-   NPM admin credentials never reach petri. or its workers.
-   No per-deployment changes to shared homelab infrastructure.
-   Application containers stay on internal Docker networks and never
    publish host ports.
-   Preview routes are owned by petri. and stored alongside the
    deployment state.

The `EdgeProxyProvider` is responsible for:

-   Creating a route for the preview hostname.
-   Setting the internal destination (container and port).
-   Attaching the edge proxy to the deployment's Docker network.
-   Removing the route when the deployment is stopped, deleted or
    expires.
-   Reconciling edge proxy routes with the database after interruptions.

### 10.1 Integration reliability

Edge proxy changes and database transactions cannot be assumed to be
atomic.

The orchestrator must therefore handle partial failures. For example, if
a container starts but route creation fails, the deployment should
remain in a recoverable state and the worker should retry or clean up
according to a defined policy.

Route operations must be idempotent: creating a route that already
exists, or removing one that is already gone, succeeds without side
effects. Because petri. owns the edge proxy, routes can be rebuilt from
the database at any time.

------------------------------------------------------------------------

## 11. Deployment orchestration

Deployments are asynchronous jobs. The REST API should return quickly
and expose progress through deployment status and events.

### 11.1 Deployment sequence

1.  Receive deployment request.
2.  Authenticate and validate the request.
3.  Create or select the project.
4.  Create a deployment record.
5.  Generate a unique subdomain.
6.  Queue a deployment job.
7.  Retrieve or extract source.
8.  Build the image.
9.  Create the application container.
10. Start the container.
11. Wait for a successful health check.
12. Create the edge proxy route.
13. Mark deployment as `READY`.
14. Publish the preview URL.

The precise ordering of proxy creation and health checks may be adjusted
to avoid exposing a broken application. The public URL should only be
advertised as ready after the health check succeeds.

### 11.2 Failure handling

Every job must be retryable where safe.

The worker should:

-   Record the failed step.
-   Store a useful error summary.
-   Preserve logs.
-   Clean up resources created by incomplete operations.
-   Avoid duplicate containers or proxy routes on retries.

A periodic reconciliation job should compare database state with actual
Docker and edge proxy state.

------------------------------------------------------------------------

## 12. API design

All endpoints are versioned under `/api/v1`.

### 12.1 Projects

  Method   Endpoint          Purpose
  -------- ----------------- -----------------
  POST     `/projects`       Create project
  GET      `/projects`       List projects
  GET      `/projects/:id`   Project details
  PATCH    `/projects/:id`   Update project
  DELETE   `/projects/:id`   Delete project

### 12.2 Deployments

  Method   Endpoint                      Purpose
  -------- ----------------------------- ----------------------------
  POST     `/deployments`                Create deployment from Git
  POST     `/deployments/upload`         Create deployment from ZIP
  GET      `/deployments`                List deployments
  GET      `/deployments/:id`            Deployment details
  POST     `/deployments/:id/redeploy`   Rebuild and redeploy
  POST     `/deployments/:id/stop`       Stop deployment
  POST     `/deployments/:id/start`      Start deployment
  DELETE   `/deployments/:id`            Delete deployment
  GET      `/deployments/:id/logs`       Retrieve logs
  GET      `/deployments/:id/events`     Stream deployment events

### 12.3 Example Git deployment request

``` json
{
  "project": "dashboard-concept",
  "source": {
    "type": "git",
    "repository": "https://github.com/example/dashboard",
    "ref": "feature/new-ui"
  },
  "build": {
    "strategy": "auto",
    "port": 3000
  },
  "lifecycle": {
    "mode": "temporary",
    "ttlHours": 48
  }
}
```

`ref` is a branch, tag or commit. The project is created if no project
with that slug exists, so one call is enough for a coding assistant.
`name` (default: the ref) and `subdomain` (default:
`<project>-<name>`) are optional.

The response includes the deployment ID, initial status and a link to
the deployment resource.

### 12.4 Coding assistant integration

Coding assistants should use the REST API with restricted API keys.

They must not receive:

-   Docker socket access.
-   NPM administrator credentials.
-   Direct database access.
-   Access to internal orchestration services.

API keys should support scopes such as:

-   `deploy:create`
-   `deploy:read`
-   `deploy:update`
-   `deploy:delete`

Keys must be revocable. The API should also support sensible rate limits
and request validation.

------------------------------------------------------------------------

## 13. Dashboard and public showcase

The frontend has two distinct areas.

### 13.1 Private lab dashboard

The dashboard provides:

-   Overview of active experiments.
-   Project management.
-   Deployment history.
-   Build logs and runtime logs.
-   Deployment actions.
-   API key management.
-   Infrastructure and domain settings.

### 13.2 Public experiment gallery

The gallery lists projects with at least one active, publicly visible
deployment.

Each experiment card should include:

-   Project name.
-   Short description.
-   Preview screenshot.
-   Current status.
-   Last updated timestamp.
-   Link to the live application.
-   A clear **Try it** action.

Where a project has multiple deployments, the gallery should show the
selected public deployment and make its version or branch clear.

The gallery must never expose environment variables, build secrets,
private repository credentials or internal infrastructure details.

### 13.3 Lab notebook identity

The interface should feel like a personal research notebook rather than
a conventional hosting dashboard.

Visual direction:

-   Warm paper backgrounds.
-   Ink-like dark typography.
-   Handwritten annotations.
-   Small hand-drawn technical sketches.
-   Experiment numbers and date stamps.
-   Subtle labels and status stamps.
-   Modern, readable controls and responsive layouts.

The product name is always styled as **petri.**

The visual language must not compromise usability. The actual
application previews remain clean, full-size and interactive.

------------------------------------------------------------------------

## 14. Lifecycle and cleanup

Deployments support two lifecycle modes.

### Temporary

A temporary deployment has an expiration timestamp.

The cleanup worker runs periodically, for example every five minutes,
and checks for expired deployments.

Cleanup procedure:

1.  Mark deployment as `DELETING`.
2.  Remove the corresponding edge proxy route.
3.  Stop the application container.
4.  Remove the container.
5.  Remove only explicitly temporary deployment resources.
6.  Retain deployment metadata, events and build history.
7.  Mark deployment as `EXPIRED`.

The user should be able to extend the expiration time.

### Permanent

A permanent deployment has no automatic expiration timestamp.

It remains active until manually stopped or deleted.

### Retention

Logs and build history should have configurable retention policies.
Application data must not be deleted implicitly merely because a
deployment expires.

------------------------------------------------------------------------

## 15. Security architecture

Running user-supplied application code is the most important security
consideration in petri.

Even in a personal homelab, a public preview platform executes
potentially untrusted code.

### 15.1 Container isolation

Application containers must:

-   Never run in privileged mode.
-   Never mount the Docker socket.
-   Never publish host ports.
-   Run with resource limits.
-   Use restricted Linux capabilities.
-   Avoid root execution where possible.
-   Be isolated from control-plane services.
-   Have no unrestricted access to internal homelab networks.

Build workers should be isolated from the control plane and application
runtime as much as practical.

A separate VM or host for builds is the recommended longer-term
architecture.

### 15.2 Network security

The platform must prevent application containers from reaching sensitive
internal services.

Particular care is needed around:

-   Router and firewall administration interfaces.
-   The NPM VM, in particular its administration interface.
-   PostgreSQL.
-   Docker Engine APIs.
-   Other homelab services.
-   Cloud metadata endpoints where applicable.

Because NPM and other homelab services sit on the LAN, outbound traffic
from application containers must be filtered on the petri. host. By
default, containers may reach the public internet but not private
address ranges. The same restriction applies to build steps.

Git source URLs must be validated to reduce SSRF risks. Repository
protocols and reachable destinations should be restricted.

### 15.3 Secrets

-   Secrets must be encrypted at rest.
-   Secrets must never appear in build or runtime logs.
-   API keys must be stored hashed where practical.
-   Credentials must be revocable.
-   Secrets must not be included in public project metadata or gallery
    responses.

### 15.4 Public versus private access

Public preview access is intentional.

The administration dashboard and management API are separate security
boundaries and must be protected through authentication.

A public application must never gain access to the private petri.
control plane merely because both run on the same Docker host.

------------------------------------------------------------------------

## 16. Deployment topology

### 16.1 MVP topology

The first installation runs petri. on one dedicated host: an
x86-64-v3 virtual machine on Proxmox. NPM stays on its existing,
separate VM:

``` text
NPM VM (existing)
└── Nginx Proxy Manager
     │  petri.example.com, *.app.example.com
     ↓
petri. Host
├── Web
├── API
├── Worker
├── Docker socket proxy
├── PostgreSQL
├── BuildKit
└── Edge proxy (Caddy)
     │
     └── Application containers
```

NPM remains an existing external dependency and is not recreated or
managed by petri.

The development machine (arm64) is separate from the petri. host and is
not part of this topology. Production images are built for
`linux/amd64`.

The application services should be managed through Docker Compose.

### 16.2 Future topology

For stronger isolation and scalability:

``` text
Control Plane Host
├── Web
├── API
└── PostgreSQL

Build Host / VM
└── Isolated BuildKit workers

Runtime Host
├── Edge proxy
└── Application containers

Existing Infrastructure (NPM VM)
└── Nginx Proxy Manager
```

This is the preferred direction once petri. runs code from more than a
small, trusted set of repositories.

------------------------------------------------------------------------

## 17. Observability and operations

The platform must provide enough information to diagnose failed
deployments and infrastructure problems.

MVP requirements:

-   Structured application logs.
-   Build logs associated with a build ID.
-   Deployment event history.
-   Runtime container status.
-   Health-check results.
-   Worker job status and retry information.
-   Clear error messages in the dashboard.

Important operational metrics include:

-   Number of active deployments.
-   Build duration.
-   Build failure rate.
-   Container resource usage.
-   Expired deployments awaiting cleanup.
-   Worker queue length.

The system should be able to recover from a worker restart without
losing deployment state.

------------------------------------------------------------------------

## 18. MVP implementation roadmap

### Phase 1 --- Foundation

-   Create monorepo.
-   Set up CI on GitHub Actions.
-   Set up Next.js, Fastify and shared TypeScript contracts.
-   Configure PostgreSQL, Drizzle and pg-boss.
-   Establish Docker Compose development environment.
-   Implement admin login and scoped API keys.

**Result:** petri. can start, persist data and protect the admin panel.

Detailed tasks for each phase are in `docs/plan.md`.

### Phase 2 --- First deployment

-   Implement Git source retrieval.
-   Implement ZIP upload and safe extraction.
-   Implement Dockerfile builds.
-   Implement Docker runtime adapter.
-   Implement deployment state machine.
-   Implement health checks and logs.

**Result:** A project can be built and run locally.

### Phase 3 --- Public previews

-   Set up the edge proxy and its adapter.
-   Create and remove preview routes.
-   Configure the static NPM proxy hosts, wildcard domain and TLS.
-   Restrict edge proxy access to the NPM VM.
-   Block outbound traffic from application containers and builds to
    private address ranges. This must be in place before any preview is
    public.
-   Implement unique subdomain generation.
-   Test public access from outside the homelab.

**Result:** A running application is accessible through its public URL.

### Phase 4 --- Dashboard and gallery

-   Build private dashboard.
-   Build project and deployment detail views.
-   Build public experiment gallery.
-   Display logs and status updates.
-   Add experiment descriptions and personal notes.

**Result:** petri. becomes usable as a personal lab notebook and public
showroom.

### Phase 5 --- Lifecycle and automation

-   Add temporary and permanent deployment modes.
-   Add TTL extension.
-   Implement cleanup worker.
-   Add buildpack support.
-   Add redeploy and recovery flows.
-   Add API endpoints for coding assistants.

**Result:** petri. can manage experiments with minimal manual
intervention.

### Phase 6 --- Hardening

-   Isolate build execution.
-   Review and tighten container network rules.
-   Review resource limits.
-   Document configuring an OIDC provider.
-   Improve secret handling.
-   Add reconciliation and failure recovery.
-   Document backup and restore procedures.

**Result:** A safer and more reliable self-hosted platform.

------------------------------------------------------------------------

## 19. Open decisions

The following decisions should be resolved before or during
implementation.

  -----------------------------------------------------------------------
  Topic                   Current proposal        Status
  ----------------------- ----------------------- -----------------------
  Product name            petri.                  Decided

  Product purpose         Personal lab notebook   Decided
                          and public app showcase 

  Main audience           Owner, with public      Decided
                          visitors                

  Preview access          Public by default       Decided

  Existing reverse proxy  Keep NPM                Decided

  NPM location            Separate VM from the    Decided
                          petri. host             

  Preview routing         Static NPM wildcard     Decided
                          host forwarding to a    
                          petri. edge proxy       

  Edge proxy              Caddy, configured via   Decided (5.2)
                          its admin API           

  Source types            Git and ZIP             Decided

  Build strategy          Dockerfile first,       Proposed
                          buildpacks fallback     

  Lifecycle               Temporary and permanent Decided

  Target server           x86-64-v3 VM on Proxmox Decided

  Code hosting and CI     GitHub + GitHub Actions Decided

  Frontend                Next.js                 Decided (5.2)

  Backend                 Fastify + Zod           Decided (5.2)

  Database                PostgreSQL + Drizzle    Decided (5.2)

  Job queue               pg-boss on PostgreSQL   Decided (5.2)

  Private Git access      Public repositories     Proposed
                          only in the MVP; deploy 
                          keys and/or tokens      
                          later                   

  Screenshot generation   Uploaded image in the   Proposed
                          MVP; automatic          
                          screenshots later       

  Build isolation         Separate VM/host in a   Recommended
                          later phase             

  Authentication          Public gallery without  Decided
                          login; admin login via  
                          Better Auth (password   
                          now, OIDC later);       
                          scoped API keys         

  License                 AGPL-3.0-or-later       Decided
  -----------------------------------------------------------------------

------------------------------------------------------------------------

## 20. Definition of done for the MVP

The first usable release is complete when the following end-to-end
scenario works:

1.  Open the petri. dashboard from a browser.
2.  Create a project.
3.  Supply a Git repository or ZIP archive.
4.  Start a deployment.
5.  Watch build and deployment progress.
6.  Receive a public preview URL.
7.  Open the preview from a device outside the homelab.
8.  Interact with the application.
9.  See the project in the public gallery.
10. Stop, restart or delete the deployment.
11. Configure an experiment to expire automatically.
12. Verify that expired deployments are cleaned up without losing their
    history.

**The central success criterion:** From a coding assistant's completed
prototype to a working public preview should be a simple API call, with
petri. taking care of the rest.

------------------------------------------------------------------------

## 21. Summary

petri. is a small, self-hosted deployment platform with a deliberately
focused purpose: make experiments accessible.

Its architecture separates the control plane, build process, runtime and
proxy integration. It uses Docker for application execution,
asynchronous workers for orchestration, PostgreSQL for persistent state,
Nginx Proxy Manager for public entry and TLS, and its own edge proxy for
routing previews.

The initial implementation prioritizes a reliable single-host deployment
workflow. The interfaces are designed so that build execution and
runtime isolation can evolve independently as the platform matures.

**petri. --- A little lab for big ideas.**
