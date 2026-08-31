#!/usr/bin/env bash
# Build and run the current checkout in an isolated, persistent manual sandbox.

set -euo pipefail

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=./docker-common.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/docker-common.sh"

usage() {
  cat <<EOF
Usage:
  ./scripts/docker-test.sh [showtail arguments...]
  ./scripts/docker-test.sh shell [bash arguments...]
  ./scripts/docker-test.sh login claude
  ./scripts/docker-test.sh login codex
  ./scripts/docker-test.sh clean

Examples:
  ./scripts/docker-test.sh --version
  ./scripts/docker-test.sh track --project "Docker Test"
  ./scripts/docker-test.sh shell
  ./scripts/docker-test.sh shell -lc 'showtail status --json'

The image is rebuilt from the current checkout. Agent/login state persists in
"$SHOWTAIL_DOCKER_HOME_VOLUME" and scratch projects persist in
"$SHOWTAIL_DOCKER_WORKSPACE_VOLUME". The first run copies only recognized Claude
and Codex credential files from the host when they are available.
EOF
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
  clean)
    for volume in "$SHOWTAIL_DOCKER_HOME_VOLUME" "$SHOWTAIL_DOCKER_WORKSPACE_VOLUME"; do
      if docker volume inspect "$volume" >/dev/null 2>&1; then
        docker volume rm "$volume" >/dev/null
        echo "Removed Docker volume: $volume"
      else
        echo "Docker volume already absent: $volume"
      fi
    done
    exit 0
    ;;
esac

showtail_docker_build
showtail_docker_prepare_volumes
showtail_docker_make_run_args
showtail_docker_make_io_args

case "${1:-}" in
  shell)
    shift
    exec docker run \
      "${SHOWTAIL_DOCKER_RUN_ARGS[@]}" \
      "${SHOWTAIL_DOCKER_IO_ARGS[@]}" \
      --workdir /workspace \
      --entrypoint /bin/bash \
      "$SHOWTAIL_DOCKER_IMAGE" "$@"
    ;;
  login)
    case "${2:-}" in
      claude)
        exec docker run \
          "${SHOWTAIL_DOCKER_RUN_ARGS[@]}" \
          "${SHOWTAIL_DOCKER_IO_ARGS[@]}" \
          --entrypoint claude \
          "$SHOWTAIL_DOCKER_IMAGE" auth login
        ;;
      codex)
        if [[ -n "${OPENAI_API_KEY:-}" ]]; then
          printf '%s' "$OPENAI_API_KEY" | docker run \
            "${SHOWTAIL_DOCKER_RUN_ARGS[@]}" \
            -i \
            --entrypoint codex \
            "$SHOWTAIL_DOCKER_IMAGE" login --with-api-key
          exit $?
        fi
        if [[ ! -t 0 || ! -t 1 ]]; then
          echo "Codex device login requires an interactive terminal." >&2
          echo "Run this command in a terminal, or set OPENAI_API_KEY." >&2
          exit 1
        fi
        exec docker run \
          "${SHOWTAIL_DOCKER_RUN_ARGS[@]}" \
          "${SHOWTAIL_DOCKER_IO_ARGS[@]}" \
          --entrypoint codex \
          "$SHOWTAIL_DOCKER_IMAGE" login --device-auth
        ;;
      *)
        echo "Choose an agent to log in: claude or codex." >&2
        exit 2
        ;;
    esac
    ;;
esac

exec docker run \
  "${SHOWTAIL_DOCKER_RUN_ARGS[@]}" \
  "${SHOWTAIL_DOCKER_IO_ARGS[@]}" \
  --workdir /workspace \
  "$SHOWTAIL_DOCKER_IMAGE" "$@"
