#!/bin/sh
# Checks what apps and builds can reach, as the firewall in
# infrastructure/firewall should allow: the public internet, and nothing
# private. Exits non-zero if something private is reachable, or the
# internet is not.
#
# Run on a petri. host with the Docker CLI (development, CI, production):
#   scripts/probe-egress.sh
# Build steps are checked through BuildKit on its network:
#   PROBE_BUILD_NETWORK  Docker network of buildkitd (default: petri-dev_build;
#                        production: petri_build)
#   PROBE_BUILDKIT_ADDR  buildkitd's address on it (tcp://buildkitd:1234)
#   PROBE_SKIP_BUILD=1   check apps only
#   PROBE_LAN_TARGETS    other machines that must be unreachable, as
#                        "host port" pairs separated by commas, e.g. the
#                        router and NPM's admin UI: "192.168.0.1 80,192.168.0.5 81".
#                        They must be listening, or the check proves nothing.
#
# Every "must not reach" target is a service that is listening, so a
# failed connection means blocked, not just closed.
set -eu

BUILD_NETWORK=${PROBE_BUILD_NETWORK:-petri-dev_build}
BUILDKIT_ADDR=${PROBE_BUILDKIT_ADDR:-tcp://buildkitd:1234}
BUILDKIT_IMAGE=moby/buildkit:v0.34.2-rootless
PROBE_IMAGE=busybox:1.37
PUBLIC_TARGET="1.1.1.1 443"

run=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
app_net="petri-probe-$run"
other_net="petri-probe-other-$run"
outside_net="petri-probe-outside-$run"
failures=0

cleanup() {
	docker rm -f "probe-peer-$run" "probe-other-$run" "probe-outside-$run" \
		"probe-host-$run" >/dev/null 2>&1 || true
	docker network rm "$app_net" "$other_net" "$outside_net" >/dev/null 2>&1 || true
	rm -rf "${context:-}"
}
trap cleanup EXIT

serve() { # name network [publish] [port]
	docker run -d --name "$1" --network "$2" ${3:+-p "$3"} "$PROBE_IMAGE" \
		sh -c "mkdir /www && echo ok > /www/index.html && exec httpd -f -p ${4:-80} -h /www" \
		>/dev/null
}
address_of() { # container network
	docker inspect -f "{{(index .NetworkSettings.Networks \"$2\").IPAddress}}" "$1"
}

echo "Preparing targets..."
docker pull -q "$PROBE_IMAGE" >/dev/null
# Two app networks, named as petri. names them (pa-*), and one that is
# not petri.'s, standing in for any other service on the host or LAN.
docker network create -o com.docker.network.bridge.name="pa-p$run" \
	"$app_net" >/dev/null
docker network create -o com.docker.network.bridge.name="pa-o$run" \
	"$other_net" >/dev/null
docker network create "$outside_net" >/dev/null
serve "probe-peer-$run" "$app_net"
serve "probe-other-$run" "$other_net"
# A service on the host itself (like SSH), on all its addresses...
host_port=$((20000 + $(od -An -N2 -tu2 /dev/urandom | tr -d ' ') % 10000))
serve "probe-host-$run" host "" "$host_port"
# ...and a container's port published on the host (forwarded by Docker).
serve "probe-outside-$run" "$outside_net" "0:80"
published=$(docker port "probe-outside-$run" 80/tcp | sed -n 's/^0\.0\.0\.0://p' | head -1)

host_lan=$(ip -4 route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p')
gateway=$(docker network inspect -f '{{(index .IPAM.Config 0).Gateway}}' "$app_net")

# name, expected (reach|blocked), host, port
TARGETS="public reach $PUBLIC_TARGET
same-network-peer reach $(address_of "probe-peer-$run" "$app_net") 80
host-lan-address blocked $host_lan $host_port
host-via-gateway blocked $gateway $host_port
host-published-port blocked $host_lan $published
other-service-container blocked $(address_of "probe-outside-$run" "$outside_net") 80
other-app-network blocked $(address_of "probe-other-$run" "$other_net") 80"
if [ -n "${PROBE_LAN_TARGETS:-}" ]; then
	TARGETS="$TARGETS
$(echo "$PROBE_LAN_TARGETS" | tr ',' '\n' | sed 's/^ *\(.*\)$/lan:\1/; s/^lan:\([^ ]*\) /lan:\1 blocked \1 /')"
fi

# Runs inside the app container and the build step. Prints
# "RESULT <name> <expected> <exit code>" per target; 0 means connected.
context=$(mktemp -d)
# Read by unprivileged users in the containers below.
chmod 755 "$context"
cat >"$context/probe.sh" <<'PROBE'
echo "$TARGETS" | while read -r name expected host port; do
	nc -w 3 "$host" "$port" </dev/null >/dev/null 2>&1 && code=0 || code=1
	echo "RESULT $name $expected $code"
done
nslookup example.com >/dev/null 2>&1 && code=0 || code=1
echo "RESULT dns-lookup reach $code"
PROBE

report() { # where; reads RESULT lines
	while read -r _ name expected code; do
		if [ "$expected" = reach ] && [ "$code" = 0 ]; then
			result="ok      reached"
		elif [ "$expected" = blocked ] && [ "$code" != 0 ]; then
			result="ok      blocked"
		elif [ "$expected" = reach ]; then
			result="FAILED  not reached"
			failures=$((failures + 1))
		else
			result="FAILED  REACHED"
			failures=$((failures + 1))
		fi
		printf '  %-6s %-24s %s\n' "$1" "$name" "$result"
	done
}

echo "From an app network:"
docker run --rm --network "$app_net" -e TARGETS="$TARGETS" \
	-v "$context/probe.sh:/probe.sh:ro" "$PROBE_IMAGE" sh /probe.sh \
	| grep '^RESULT' >"/tmp/probe-$run" || true
report app <"/tmp/probe-$run"

# The other direction still works: the host reaching an app, as the
# worker does for health checks (only replies come back from the app).
docker run --rm --network host "$PROBE_IMAGE" \
	nc -w 3 "$(address_of "probe-peer-$run" "$app_net")" 80 </dev/null >/dev/null 2>&1 &&
	code=0 || code=1
echo "RESULT host-to-app reach $code" >"/tmp/probe-$run"
report app <"/tmp/probe-$run"

if [ "${PROBE_SKIP_BUILD:-}" != 1 ]; then
	echo "From a build step:"
	# RUN differs per probe, so the step is never taken from the cache.
	printf 'FROM %s\nCOPY probe.sh /probe.sh\nARG RUN\nARG TARGETS\nRUN sh /probe.sh\n' \
		"$PROBE_IMAGE" >"$context/Dockerfile"
	chmod 644 "$context/Dockerfile" "$context/probe.sh"
	# The build network's own gateway, instead of the app network's.
	build_gateway=$(docker network inspect -f '{{(index .IPAM.Config 0).Gateway}}' "$BUILD_NETWORK")
	build_targets=$(echo "$TARGETS" | grep -v -e '^same-network-peer' -e '^host-via-gateway')
	build_targets="$build_targets
host-via-gateway blocked $build_gateway $host_port"
	docker run --rm --network "$BUILD_NETWORK" -v "$context:/ctx:ro" \
		--entrypoint buildctl "$BUILDKIT_IMAGE" --addr "$BUILDKIT_ADDR" \
		build --progress=plain --frontend dockerfile.v0 \
		--local context=/ctx --local dockerfile=/ctx \
		--opt build-arg:RUN="$run" --opt build-arg:TARGETS="$build_targets" \
		2>&1 | sed -n 's/^#[0-9]* [0-9.]* \(RESULT .*\)$/\1/p' >"/tmp/probe-$run" || true
	if [ ! -s "/tmp/probe-$run" ]; then
		echo "  build  FAILED  the probe build produced no results"
		failures=$((failures + 1))
	fi
	report build <"/tmp/probe-$run"
fi
rm -f "/tmp/probe-$run"

if [ "$failures" -gt 0 ]; then
	echo "$failures check(s) failed."
	exit 1
fi
echo "All checks passed."
