# petri. --- Operations

Installing, configuring and upgrading petri. on its production host.
`example.com` and the addresses below are placeholders.

  What                    Example                 Where it's set
  ----------------------- ----------------------- -------------------------------
  Admin panel             `petri.example.com`     DNS, NPM, `PUBLIC_URL`
  Previews                `*.app.example.com`     DNS, NPM, `PREVIEW_BASE_URL`
  petri. host (this VM)   `192.168.0.10`          `WEB_BIND`, `EDGE_BIND`
  NPM VM                  `192.168.0.5`           `NPM_ADDRESS`, firewall
  Admin network (SSH)     `192.168.0.0/24`        firewall

```text
Internet ──443──> router ──> NPM VM (TLS, two static proxy hosts)
                                │ petri.example.com  → 192.168.0.10:3000 (web)
                                │ *.app.example.com  → 192.168.0.10:8080 (edge proxy)
                                ↓
                petri. host: web, API, worker, PostgreSQL, BuildKit,
                Docker socket proxy, edge proxy (Caddy), apps
```

Only NPM reaches the two published ports; apps and builds reach the
internet but nothing on the LAN. Both are enforced by the host firewall
(step 3).

------------------------------------------------------------------------

## 1. Prepare the VM

An x86-64-v3 VM (Debian 13 or Ubuntu 24.04), with Docker Engine and its
Compose plugin installed from Docker's own repository
(<https://docs.docker.com/engine/install/>), plus:

```bash
sudo apt install git nftables
sudo usermod -aG docker "$USER"    # log in again afterwards
```

Give the VM a fixed LAN address (DHCP reservation or static).

## 2. Get petri. and configure it

```bash
sudo mkdir -p /opt/petri && sudo chown "$USER" /opt/petri
git clone https://github.com/olafrose/petri-paas.git /opt/petri
cd /opt/petri
cp .env.example .env
```

In `.env`, set at least:

```bash
NODE_ENV=production
LOG_LEVEL=info
PUBLIC_URL=https://petri.example.com
PREVIEW_BASE_URL=https://app.example.com
AUTH_SECRET=...            # openssl rand -base64 32
POSTGRES_PASSWORD=...      # openssl rand -hex 24
NPM_ADDRESS=192.168.0.5
# Published on the VM's LAN address, for NPM:
WEB_BIND=192.168.0.10
EDGE_BIND=192.168.0.10
```

The development values in `.env.example` (`DATABASE_URL`, `API_HOST`,
`TRUST_PROXY`) are ignored: `docker-compose.yml` sets its own.

Keep `.env` private (`chmod 600 .env`): it holds the database password
and the session secret.

## 3. Install the firewall

Before anything runs, so no app is ever unfiltered:

```bash
sudo scripts/install-firewall.sh --npm 192.168.0.5 --ssh-from 192.168.0.0/24
```

- Apps and builds: public internet only (`infrastructure/firewall/petri.nft`).
- Ports 3000 and 8080: only from NPM. Use `--ports` if you changed
  `WEB_PORT`/`EDGE_PORT`.
- SSH: only from the admin network. The script refuses if your own SSH
  session comes from elsewhere. Leave out `--ssh-from` if Proxmox already
  restricts SSH.

`--dry-run` shows the access rules without applying anything. The rules
are loaded before Docker on every boot, and Docker requires them: if
they can't be loaded, Docker doesn't start.

## 4. Start the stack

CI publishes images to GHCR from `main` (`ghcr.io/olafrose/petri-api`,
`-worker`, `-web`). GitHub makes new packages private: either set each
package's visibility to public (GitHub → Packages → package → Package
settings), or log in once with a token that has `read:packages`:

```bash
docker login ghcr.io -u <github-user>
```

Then:

```bash
docker compose pull
docker compose up -d
docker compose ps            # all running, api/web/edge healthy
docker compose exec api node dist/cli/set-owner.js --email you@example.com --name "Your Name"
```

`set-owner` asks for the password (hidden). Run it again to set a new
one; that also signs out all sessions.

## 5. Check the firewall

```bash
PROBE_BUILD_NETWORK=petri_build \
PROBE_LAN_TARGETS="192.168.0.1 80,192.168.0.5 81" \
scripts/probe-egress.sh
```

`PROBE_LAN_TARGETS` lists machines that must stay unreachable from apps,
and that are listening (here: the router's web UI and NPM's admin UI).
Every check must pass. Run it again after changing the firewall or the
host's network.

## 6. DNS and certificate

DNS records, both pointing to the homelab's public IP (or a CNAME to a
dynamic DNS name):

  Name                  Type
  --------------------- -------------
  `petri.example.com`   A / AAAA / CNAME
  `*.app.example.com`   A / AAAA / CNAME

In NPM, *SSL Certificates → Add → Let's Encrypt*, with **both** names,
`petri.example.com` and `*.app.example.com`, and *Use a DNS Challenge*
(wildcards need DNS-01) with your DNS provider's API credentials. A
certificate for `*.example.com` alone does not cover
`demo.app.example.com`.

## 7. NPM proxy hosts

Two, created once; petri. never changes them.

  Setting                    `petri.example.com`        `*.app.example.com`
  -------------------------- -------------------------- --------------------------
  Scheme, forward host, port `http`, `192.168.0.10`, `3000`  `http`, `192.168.0.10`, `8080`
  Websockets support         on                         on (apps may use them)
  Block common exploits      on                         off (it can break apps)
  SSL certificate            the one from step 6        the same
  Force SSL, HTTP/2          on                         on
  HSTS                       optional                   off (see below)

HSTS on previews would pin every future `*.app.example.com` name to
HTTPS in visitors' browsers; harmless here, but not needed.

ZIP uploads can be up to 100 MB: if NPM's *Advanced* tab or a custom
config limits `client_max_body_size`, allow at least that for
`petri.example.com`.

## 8. Try it from outside

From a device outside the homelab (e.g. a phone on mobile data):

1. Open `https://petri.example.com/admin` and sign in.
2. Create an API key (`POST /api/v1/api-keys`, or the API docs at
   `/api/v1/docs`), deploy a small app, and open the `url` it reports.

------------------------------------------------------------------------

## Upgrading

```bash
cd /opt/petri
git pull                        # Compose file, Caddy and firewall config
docker compose pull
docker compose up -d            # migrations run when the API starts
sudo scripts/install-firewall.sh   # if infrastructure/firewall changed
```

Without options, `install-firewall.sh` keeps the access rules from the
first installation and applies the rest atomically.

To pin a version, set `PETRI_TAG=sha-<commit>` in `.env` (tags are on
the GHCR package pages); `PETRI_TAG=main` follows `main`.

## Day to day

  Task                          Command
  ----------------------------- ------------------------------------------
  Logs of a service             `docker compose logs -f worker`
  Status                        `docker compose ps`
  Restart everything            `docker compose restart`
  Firewall status               `systemctl status petri-firewall`
  Current firewall rules        `sudo nft list table inet petri`

**Backups** (procedures follow in phase 6): the database holds all
state; uploads and build logs are in the `petri_uploads` and
`petri_build-logs` volumes.

```bash
docker compose exec -T postgres pg_dump -U petri petri | gzip > petri-$(date +%F).sql.gz
```

## Troubleshooting

- **Docker doesn't start after a reboot:** the firewall rules couldn't
  be loaded. `systemctl status petri-firewall` and
  `sudo nft -c -f /etc/petri/petri.nft` show why.
- **A preview answers "No preview at this address.":** it isn't ready,
  or its route is missing. The worker restores routes within 30 s;
  `docker compose logs worker | grep route` shows what it did.
- **A preview answers 502:** the route exists but the app isn't
  answering, e.g. it crashed. Check the deployment's events and logs.
- **Every sign-in counts against one rate limit:** `NPM_ADDRESS` is
  missing or wrong, so the API can't see visitors' addresses.
