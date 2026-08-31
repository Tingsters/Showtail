#!/usr/bin/env bash
# Shared image, volume, and credential setup for the local Docker test runners.

SHOWTAIL_DOCKER_ROOT=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
SHOWTAIL_DOCKER_IMAGE=${SHOWTAIL_DOCKER_IMAGE:-showtail:dev}
SHOWTAIL_DOCKER_HOME_VOLUME=${SHOWTAIL_DOCKER_HOME_VOLUME:-showtail-test-home}
SHOWTAIL_DOCKER_WORKSPACE_VOLUME=${SHOWTAIL_DOCKER_WORKSPACE_VOLUME:-showtail-test-workspace}
SHOWTAIL_DOCKER_IDENTITY_NAME=${SHOWTAIL_DOCKER_IDENTITY_NAME:-Docker Tester}
SHOWTAIL_DOCKER_IDENTITY_EMAIL=${SHOWTAIL_DOCKER_IDENTITY_EMAIL:-docker@example.invalid}
SHOWTAIL_DOCKER_CONTAINER_HOME=/home/showtail

showtail_docker_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf '%s\n' x64 ;;
    aarch64|arm64) printf '%s\n' arm64 ;;
    *)
      echo "Unsupported host architecture: $(uname -m)" >&2
      return 1
      ;;
  esac
}

showtail_docker_build() {
  local arch
  arch=$(showtail_docker_arch)
  docker build \
    --build-arg "BUN_TARGET=bun-linux-$arch" \
    --tag "$SHOWTAIL_DOCKER_IMAGE" \
    "$SHOWTAIL_DOCKER_ROOT"
}

showtail_docker_collect_auth_mounts() {
  local host_home=${HOME:-}
  SHOWTAIL_DOCKER_AUTH_MOUNTS=()
  if [[ -z "$host_home" ]]; then
    return
  fi
  if [[ -f "$host_home/.claude.json" ]]; then
    SHOWTAIL_DOCKER_AUTH_MOUNTS+=(
      --volume "$host_home/.claude.json:/run/showtail-host-auth/claude.json:ro"
    )
  fi
  if [[ -f "$host_home/.claude/.credentials.json" ]]; then
    SHOWTAIL_DOCKER_AUTH_MOUNTS+=(
      --volume "$host_home/.claude/.credentials.json:/run/showtail-host-auth/claude-credentials.json:ro"
    )
  fi
  if [[ -f "$host_home/.codex/auth.json" ]]; then
    SHOWTAIL_DOCKER_AUTH_MOUNTS+=(
      --volume "$host_home/.codex/auth.json:/run/showtail-host-auth/codex-auth.json:ro"
    )
  fi
}

showtail_docker_prepare_volumes() {
  showtail_docker_collect_auth_mounts
  docker run --rm --user root \
    "${SHOWTAIL_DOCKER_AUTH_MOUNTS[@]}" \
    --volume "$SHOWTAIL_DOCKER_HOME_VOLUME:$SHOWTAIL_DOCKER_CONTAINER_HOME" \
    --volume "$SHOWTAIL_DOCKER_WORKSPACE_VOLUME:/workspace" \
    --entrypoint /bin/bash \
    "$SHOWTAIL_DOCKER_IMAGE" -c '
      set -euo pipefail
      install -d -m 700 -o 1001 -g 1001 \
        /home/showtail \
        /home/showtail/.claude \
        /home/showtail/.codex
      chown 1001:1001 /workspace
      if [[ -f /run/showtail-host-auth/claude.json && ! -e /home/showtail/.claude.json ]]; then
        install -m 600 -o 1001 -g 1001 \
          /run/showtail-host-auth/claude.json /home/showtail/.claude.json
      fi
      if [[ -f /run/showtail-host-auth/claude-credentials.json && ! -e /home/showtail/.claude/.credentials.json ]]; then
        install -m 600 -o 1001 -g 1001 \
          /run/showtail-host-auth/claude-credentials.json \
          /home/showtail/.claude/.credentials.json
      fi
      if [[ -f /run/showtail-host-auth/codex-auth.json && ! -e /home/showtail/.codex/auth.json ]]; then
        install -m 600 -o 1001 -g 1001 \
          /run/showtail-host-auth/codex-auth.json /home/showtail/.codex/auth.json
      fi
    '
}

showtail_docker_make_run_args() {
  SHOWTAIL_DOCKER_RUN_ARGS=(
    --rm
    --init
    --cap-drop ALL
    --security-opt no-new-privileges
    --env "SHOWTAIL_IDENTITY_NAME=$SHOWTAIL_DOCKER_IDENTITY_NAME"
    --env "SHOWTAIL_IDENTITY_EMAIL=$SHOWTAIL_DOCKER_IDENTITY_EMAIL"
    --volume "$SHOWTAIL_DOCKER_HOME_VOLUME:$SHOWTAIL_DOCKER_CONTAINER_HOME"
    --volume "$SHOWTAIL_DOCKER_WORKSPACE_VOLUME:/workspace"
  )
  [[ -n "${TERM:-}" ]] && SHOWTAIL_DOCKER_RUN_ARGS+=(--env "TERM=$TERM")
  [[ -n "${COLORTERM:-}" ]] && SHOWTAIL_DOCKER_RUN_ARGS+=(--env "COLORTERM=$COLORTERM")
  [[ -n "${TERM_PROGRAM:-}" ]] && SHOWTAIL_DOCKER_RUN_ARGS+=(--env "TERM_PROGRAM=$TERM_PROGRAM")
  if [[ -n "${TERM_PROGRAM_VERSION:-}" ]]; then
    SHOWTAIL_DOCKER_RUN_ARGS+=(--env "TERM_PROGRAM_VERSION=$TERM_PROGRAM_VERSION")
  fi
}

showtail_docker_make_io_args() {
  SHOWTAIL_DOCKER_IO_ARGS=(-i)
  if [[ -t 0 && -t 1 ]]; then
    SHOWTAIL_DOCKER_IO_ARGS+=(-t)
  fi
}
