# Installation

There are three ways to install Showtail. The one-line installer is the fastest
and needs no runtime; the other two are for people who already use [Bun](https://bun.sh)
or want to build from source.

## Option 1: One-line install, no runtime required

These scripts download a standalone `showtail` binary from the latest GitHub
Release. You do not need Node, Bun, or any other runtime installed. The installer
also **turns tracking on for you** — it connects the AI tools it finds and pre-wires
integrations that are safe to configure before their host exists, so there is no setup
command. If you add an AI tool later, install it before Showtail when possible or run
`showtail connect <tool>` before that tool's first session. Use `showtail setup --off` to
disable automatic creation of new project trails; disconnect a tool to stop its capture.

Before running the installer, note the user-level changes it makes:

- downloads the Showtail executable and bundled VS Code extension into the
  Showtail installation directory;
- adds that directory to your user `PATH`;
- creates machine-local state under `~/.showtail-cli/`;
- enables automatic local capture and may add Showtail hooks, instructions, or
  an extension to detected AI tools.

Set the `SHOWTAIL_DISABLE_FIRST_RUN` environment variable to `1` before
installation to download the program without enabling capture or changing
AI-tool configuration. In PowerShell, run
`$env:SHOWTAIL_DISABLE_FIRST_RUN = '1'` first. See
[Uninstallation](uninstallation.md) for complete removal instructions and
[Code signing policy](../code-signing-policy.md) for Windows signature status.

=== "macOS / Linux"

    ```bash
    curl -fsSL https://raw.githubusercontent.com/Tingsters/Showtail/main/install.sh | bash
    ```

=== "Windows PowerShell"

    ```powershell
    irm https://raw.githubusercontent.com/Tingsters/Showtail/main/install.ps1 | iex
    ```

### Supported platforms

The installer detects your OS and CPU and fetches the matching binary:

| Platform | Architectures |
| --- | --- |
| Linux | x86-64, ARM64 (`aarch64`) |
| macOS | Intel (x86-64), Apple Silicon (ARM64) |
| Windows | x86-64 |

ARM64 Linux is a first-class target, so the one-line installer works on a
Raspberry Pi (64-bit Raspberry Pi OS), an ARM Chromebook's Linux container, and
ARM cloud instances — no from-source build needed.

### Updating

Once Showtail is installed as a standalone binary, update it in place with:

```bash
showtail update
```

The command checks the latest stable `Tingsters/Showtail` GitHub release,
downloads the binary for the current platform, verifies its size and SHA-256
digest, then replaces the installed executable. The bundled VS Code / Antigravity
extension is refreshed beside it, and connected integrations update themselves
the next time Showtail runs.

Useful variants:

```bash
showtail update --check           # Check without installing
showtail update --json            # Machine-readable result
showtail update --auto-check off  # Disable quiet automatic checks
showtail update --auto-check on   # Re-enable them
```

Interactive commands check public GitHub release metadata at most once per day.
If a newer version is available, Showtail mentions it once and then no more than
weekly. Failed or offline checks stay silent and never affect the command you ran.
Set `SHOWTAIL_DISABLE_UPDATE_CHECK=1` to disable checks for the current environment.

Showtail never overwrites Bun or a source checkout. `showtail update --check`
still works there, but installing a newer version means pulling the repository and
rebuilding it.

### Upgrading older trails

When an upgrade introduces richer transcript history, an existing installation
gets one migration offer. Pressing Enter accepts: Showtail scans your home folder
for existing `.showtail/` projects, previews the eligible repositories and
sessions, then asks once before adding recovered details. The scan starts only
after you opt in and nothing is uploaded.

The macOS/Linux installer reads this prompt from the controlling terminal even
though the installer itself is piped through `bash`. If an upgrade has no terminal
(for example a source build updated in the background), the offer waits for the
next interactive Showtail command. Choosing no dismisses it; you can always run
`showtail migrate` later inside a project.

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

- [Quickstart](quickstart.md) — open a project, work normally, and generate your first report.
- [Integrations](../integrations/index.md) — set up Showtail for your specific AI tool.
- [Uninstallation](uninstallation.md) — remove integrations, the executable, and optional local state.
