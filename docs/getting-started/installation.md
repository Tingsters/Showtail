# Installation

There are three ways to install Showtail. The one-line installer is the fastest
and needs no runtime; the other two are for people who already use [Bun](https://bun.sh)
or want to build from source.

## Option 1: One-line install, no runtime required

These scripts download a standalone `showtail` binary from the latest GitHub
Release. You do not need Node, Bun, or any other runtime installed. The installer
also **turns tracking on for you** — it connects the AI tools it finds and pre-wires
the ones it supports, so you never run a setup command and never lose work to a tool
you install later. (Turn it off anytime with `showtail setup --off`.)

=== "macOS / Linux"

    ```bash
    curl -fsSL https://raw.githubusercontent.com/Tingsters/Showtail/main/install.sh | bash
    ```

=== "Windows PowerShell"

    ```powershell
    irm https://raw.githubusercontent.com/Tingsters/Showtail/main/install.ps1 | iex
    ```

## Option 2: Install with Bun

If you already use [Bun](https://bun.sh), you can run Showtail from source:

```bash
git clone https://github.com/Tingsters/Showtail.git
cd Showtail
bun install
bun run src/cli.ts --help
```

To build your own standalone binary:

```bash
bun run build
```

The binary is written to `dist/showtail`.

!!! note "Bun / from-source installs turn on the same way"
    The one-line installer turns tracking on as it runs. With Bun or a from-source
    build there's no installer step, so Showtail turns tracking on **the first time you
    run any `showtail` command** instead — still no setup command to remember.

## Option 3: Build from source

Clone the repository, install dependencies with Bun, and either run the CLI
directly or build a standalone binary:

```bash
git clone https://github.com/Tingsters/Showtail.git
cd Showtail
bun install

# Run the CLI directly
bun run src/cli.ts <command>

# Or build a binary
bun run build
```

Put `dist/showtail` on your `PATH` if you want to run it as `showtail` from
anywhere.

## Next steps

- [Quickstart](quickstart.md) — connect a tool and start capturing in a couple of minutes.
- [Integrations](../integrations/index.md) — set up Showtail for your specific AI tool.
