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

## 0. Choose the VM

  Resource   Recommendation                       Why
  ---------- ------------------------------------ ------------------------------------------
  CPU        4 vCPU, type `x86-64-v3` (or `host`)  Two builds at a time; each app up to 1 core
  RAM        8 GB (6 GB minimum)                   Each app up to 512 MB; the stack itself
                                                   needs about 1.5--2 GB, builds more
  Disk       100 GB, SSD, thin-provisioned         BuildKit cache (up to 20 GB), one image per
                                                   preview, uploads, logs, database

8 GB runs about 8--10 previews at once. In Proxmox:

-   **Memory ballooning off.** petri. relies on the memory limits Docker
    enforces; memory taken away underneath the VM brings in the kernel's
    out-of-memory killer, which ends whatever it picks.
-   Disk: VirtIO SCSI single, **Discard** and **IO thread** on, so space
    freed by removed images goes back to the storage.
-   Network: VirtIO. QEMU guest agent enabled (installed in step 1), for
    consistent snapshot backups.
-   Start at boot; scheduled backups (vzdump, snapshot mode). Keep the
    `pg_dump` under *Day to day* as well: a dump is easier to restore than
    a whole VM.

Network placement:

-   A fixed LAN address (DHCP reservation or static).
-   **Ideally its own VLAN (a DMZ)**, with router rules that let only NPM
    reach ports 3000 and 8080. The host firewall already keeps apps off the
    LAN; this is a second layer, and limits what's within reach if a
    container ever escaped Docker. In the same LAN as everything else, the
    firewall's `--npm` and `--ssh-from` (step 3) are the protection.
-   IPv6 for Docker stays off (Docker's default); the host access rules
    expect IPv4 for the published ports.

Keep this VM to petri. alone: it runs code from repositories, and the
worker controls Docker. NPM, other services and their secrets belong
elsewhere. It also can't double as a development machine: both stacks
create the `pb-build` network.

## 1. Prepare the VM

Debian 13 (as tested; Ubuntu 24.04 should work too: both use cgroup v2,
which enforces the apps' memory limits, and nftables). Install Docker
Engine and its Compose plugin from Docker's own repository
(<https://docs.docker.com/engine/install/>), then:

```bash
sudo apt install git nftables qemu-guest-agent unattended-upgrades
sudo usermod -aG docker "$USER"    # log in again afterwards
```

Cap the logs of petri.'s own containers (apps already have a limit;
Docker's default keeps everything):

```bash
echo '{"log-driver": "json-file", "log-opts": {"max-size": "10m", "max-file": "3"}}' \
  | sudo tee /etc/docker/daemon.json
sudo systemctl restart docker
```

Give the host itself 1--2 GB of swap (or zram) if the image has none;
apps can't use it, petri. prevents that.

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

From a device outside the homelab (e.g. a phone on mobile data), open
`https://petri.example.com/admin` and sign in.

Then deploy a small app. Until the dashboard can (phase 4), through the
API, from any Linux machine. `PETRI` must match `PUBLIC_URL` exactly,
`https://` included: sign-ins from any other origin are refused
(`INVALID_ORIGIN`).

```bash
PETRI=https://petri.example.com
read -rp "Email: " EMAIL; read -rsp "Password: " PASS; echo
J='content-type: application/json'; O="origin: $PETRI"

# Sign in, and create an API key (shown only now; kept in $KEY)
curl -s -c /tmp/petri-jar -H "$J" -H "$O" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" \
  $PETRI/api/v1/auth/sign-in/email >/dev/null
KEY=$(curl -s -b /tmp/petri-jar -H "$J" -H "$O" \
  -d '{"name":"first test","scopes":["deploy:read","deploy:create","deploy:update","deploy:delete"]}' \
  $PETRI/api/v1/api-keys | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')
rm -f /tmp/petri-jar; unset PASS
echo "API key: ${KEY:0:12}…"

# A one-file app, uploaded as a ZIP
mkdir -p /tmp/hello/site && cd /tmp/hello
printf 'FROM busybox:1.37\nRUN mkdir /www && echo "<h1>Hello from petri.</h1>" > /www/index.html\nEXPOSE 8080\nCMD ["httpd","-f","-p","8080","-h","/www"]\n' > site/Dockerfile
python3 -c "import zipfile; z=zipfile.ZipFile('hello.zip','w'); z.write('site/Dockerfile'); z.close()"
R=$(curl -s -H "authorization: Bearer $KEY" -F archive=@hello.zip \
  -F 'settings={"project":"hello","name":"first"}' $PETRI/api/v1/deployments/upload)
# The deployment's id is the response's first field (the build inside
# it has an "id" too).
ID=$(echo "$R" | sed -n 's/^{"id":"\([^"]*\)".*/\1/p'); echo "$R" | grep -o '"url":"[^"]*"'

# Follow it until ready (or failed)
for i in $(seq 60); do
  S=$(curl -s -H "authorization: Bearer $KEY" $PETRI/api/v1/deployments/$ID | grep -o '"status":"[^"]*"' | head -1)
  echo "$S"; case $S in *ready*|*failed*) break;; esac; sleep 3
done
```

Open the printed `url` from outside: it shows "Hello from petri.". If
the status ends in `failed`, `$PETRI/api/v1/deployments/$ID/events`
says which step failed and why. Delete the test app with
`curl -X DELETE -H "authorization: Bearer $KEY" $PETRI/api/v1/deployments/$ID`.

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
