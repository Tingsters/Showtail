#!/usr/bin/env bash
# Run the real-agent capture regression in the reproducible Docker test image.

set -euo pipefail

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=./docker-common.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/docker-common.sh"

usage() {
  cat <<EOF
Usage:
  ./scripts/docker-live-test.sh
  ./scripts/docker-live-test.sh --check

--check builds the image and validates agent installation/authentication without
calling a model. The default command drives Claude Code and Codex and consumes
model quota.
EOF
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
  --check|'') ;;
  *)
    usage >&2
    exit 2
    ;;
esac

showtail_docker_build
showtail_docker_prepare_volumes
showtail_docker_make_run_args
SHOWTAIL_DOCKER_RUN_ARGS+=(
  --env "CLAUDE_CONFIG_DIR=$SHOWTAIL_DOCKER_CONTAINER_HOME/.claude"
  --env "CODEX_HOME=$SHOWTAIL_DOCKER_CONTAINER_HOME/.codex"
)

docker run \
  "${SHOWTAIL_DOCKER_RUN_ARGS[@]}" \
  --workdir /src \
  --entrypoint /bin/bash \
  "$SHOWTAIL_DOCKER_IMAGE" -c '
    set -euo pipefail
    showtail --version >/dev/null
    claude --version >/dev/null
    codex --version >/dev/null
    if ! claude auth status --json >/dev/null 2>&1; then
      echo "Claude Code is not authenticated in the Docker test home." >&2
      echo "Run: ./scripts/docker-test.sh login claude" >&2
      exit 20
    fi
    if ! codex login status >/dev/null 2>&1; then
      echo "Codex is not authenticated in the Docker test home." >&2
      echo "Run: ./scripts/docker-test.sh login codex" >&2
      exit 21
    fi
  '

if [[ "${1:-}" == "--check" ]]; then
  echo "Docker image, agent CLIs, and authentication are ready."
  exit 0
fi

echo "Running live Claude Code and Codex capture tests; this consumes model quota."
exec docker run \
  "${SHOWTAIL_DOCKER_RUN_ARGS[@]}" \
  --env SHOWTAIL_LIVE=1 \
  --env SHOWTAIL_DISABLE_FIRST_RUN=1 \
  --workdir /src \
  --entrypoint bun \
  "$SHOWTAIL_DOCKER_IMAGE" test tests/live/capture.live.test.ts
