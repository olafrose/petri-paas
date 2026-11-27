# syntax=docker/dockerfile:1
#
# Builds an app without a Dockerfile with Cloud Native Buildpacks
# (Paketo), inside BuildKit like any Dockerfile build: no Docker daemon,
# no registry. `pack` would need one of them for the lifecycle's
# exporter; instead, the second stage assembles what the exporter would.
#
# Contexts: the source (`context`) and the buildpack settings
# (`platform`: one file per variable, e.g. BP_NODE_VERSION).
# Build argument: PORT, the port the app listens on.
#
# Builder and run image belong together (same stack, Ubuntu Noble).
# Kept up to date by Dependabot.

FROM paketobuildpacks/ubuntu-noble-builder:0.0.236 AS build
USER root
RUN mkdir -p /workspace /layers /out/cnb/process && \
	chown -R cnb:cnb /workspace /layers /out
COPY --chown=cnb:cnb . /workspace
COPY --from=platform . /platform/env
USER cnb
ENV CNB_PLATFORM_API=0.13
RUN /cnb/lifecycle/detector -app=/workspace -layers=/layers \
		-platform=/platform -order=/cnb/order.toml && \
	/cnb/lifecycle/builder -app=/workspace -layers=/layers \
		-platform=/platform
# What the app runs with: the layers marked `launch = true`, and the
# launcher, started as /cnb/process/<type> for each process type.
RUN set -e; \
	for toml in /layers/*/*.toml; do \
		layer="${toml%.toml}"; \
		[ -d "$layer" ] || continue; \
		grep -Eq '^\s*launch\s*=\s*true' "$toml" || rm -rf "$layer"; \
	done; \
	rm -rf /layers/sbom; \
	metadata=/layers/config/metadata.toml; \
	type=$(sed -n 's/^buildpack-default-process-type = "\(.*\)"$/\1/p' "$metadata"); \
	if [ -z "$type" ]; then \
		echo "No start command found: add a Procfile with a web process, e.g. 'web: node server.js'"; \
		exit 1; \
	fi; \
	if grep -Eq '^\s*command = \["python"\]$' "$metadata" && \
		! grep -Eq '^\s*args = \[.+\]$' "$metadata"; then \
		echo "No start command found: add a Procfile with a web process, e.g. 'web: gunicorn --bind 0.0.0.0:\$PORT app:app'"; \
		exit 1; \
	fi; \
	cp /cnb/lifecycle/launcher /out/cnb/launcher; \
	for name in $(sed -n 's/^  type = "\(.*\)"$/\1/p' "$metadata"); do \
		ln -s ../launcher "/out/cnb/process/$name"; \
	done; \
	printf '#!/bin/sh\nexec /cnb/process/%s "$@"\n' "$type" > /out/cnb/start; \
	chmod 755 /out/cnb/start; \
	echo "Start command: process \"$type\""

FROM paketobuildpacks/ubuntu-noble-run:0.0.166
# Owned by the build user, as the exporter does: the app (another user,
# in the same group) can read its files but not change them.
COPY --from=build --chown=1001:1001 /layers /layers
COPY --from=build --chown=1001:1001 /workspace /workspace
COPY --from=build /out/cnb /cnb
ARG PORT=8080
ENV CNB_LAYERS_DIR=/layers CNB_APP_DIR=/workspace CNB_PLATFORM_API=0.13 \
	PORT=${PORT}
WORKDIR /workspace
EXPOSE ${PORT}
ENTRYPOINT ["/cnb/start"]
