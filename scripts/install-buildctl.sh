#!/bin/sh
# Copies the BuildKit client (buildctl) out of the same image the daemon
# uses, into .tools/bin. Needed for builds and the integration tests.
set -eu

IMAGE="moby/buildkit:v0.34.2-rootless"
TARGET="$(dirname "$0")/../.tools/bin"

mkdir -p "$TARGET"
container=$(docker create "$IMAGE")
trap 'docker rm "$container" >/dev/null' EXIT
docker cp "$container:/usr/bin/buildctl" "$TARGET/buildctl"
"$TARGET/buildctl" --version
