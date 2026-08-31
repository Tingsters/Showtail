# Build the current checkout and keep the source runtime available for live tests.
FROM oven/bun:1 AS tooling

USER root

RUN apt-get update \
    && apt-get install --no-install-recommends -y bash ca-certificates curl git ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1001 --shell /bin/bash showtail \
    && install -d -o showtail -g showtail /workspace /opt/claude /opt/codex

# Keep agent runtimes outside the named test home so resetting sandbox state does
# not require reinstalling them. Rebuilding this layer picks up current releases.
RUN HOME=/opt/claude bash -c 'curl -fsSL https://claude.ai/install.sh | bash' \
    && test -x /opt/claude/.local/bin/claude \
    && ln -s /opt/claude/.local/bin/claude /usr/local/bin/claude
RUN HOME=/opt/codex sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' \
    && test -x /opt/codex/.local/bin/codex \
    && ln -s /opt/codex/.local/bin/codex /usr/local/bin/codex

FROM tooling AS test

ARG BUN_TARGET=bun-linux-x64

WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun build --compile --target="$BUN_TARGET" ./src/cli.ts --outfile /tmp/showtail \
    && install -m 0755 /tmp/showtail /usr/local/bin/showtail

USER showtail
ENV HOME=/home/showtail \
    PATH=/opt/claude/.local/bin:/opt/codex/.local/bin:/usr/local/bin:/usr/bin:/bin
WORKDIR /workspace

ENTRYPOINT ["showtail"]
CMD ["--help"]
