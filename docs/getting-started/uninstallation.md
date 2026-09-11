# Uninstallation

Showtail's installer changes only the current user's files and configuration.
Removing the executable alone does not remove capture hooks or editor extensions,
so disconnect those first.

## 1. Stop capture

First disable automatic creation of new project trails:

```powershell
showtail setup --off
```

This does **not** remove capture hooks or stop connected tools from writing to
existing trails. Disconnect each integration to stop its capture. With no scope
flag, `disconnect` records a durable machine-wide stop for that tool and removes
the user- and current-project wiring it can reach. A stale hook or extension left
in another project becomes dormant and exits before reading or writing capture data:

```powershell
showtail disconnect claude
showtail disconnect codex
showtail disconnect copilot
showtail disconnect copilot-cli
showtail disconnect antigravity-cli
showtail disconnect antigravity-ide
```

Use an explicit `--user` or `--project` flag only when you intentionally want to
remove one scope and leave the other connected. A scoped disconnect does not set
the machine-wide runtime stop.

For extension-backed integrations, `disconnect` also asks the editor's command-line
tool to uninstall the Showtail extension. If that command-line tool is unavailable
or removal fails, the warning means the native component remains installed, not that
Showtail capture is still running: the bare disconnect's machine-wide stop still
applies. Use the native fallback command shown in the warning to finish cleanup
before removing the Showtail executable, for example:

```powershell
code --uninstall-extension Tingsters.showtail
antigravity-ide --uninstall-extension tingsters.showtail
```

Reload or close any open VS Code or Antigravity IDE windows after disconnecting
or updating Showtail. An extension process loaded before the change stays in
memory until the editor reloads, even after its files have been removed.

Commands for tools that are not installed may fail harmlessly.

## 2. Remove the Windows installation

The default installation directory is `%LOCALAPPDATA%\Showtail\bin`. The following
PowerShell removes that directory from the user `PATH` and deletes the installed
binary and bundled VSIX:

```powershell
$binDir = Join-Path $env:LOCALAPPDATA 'Showtail\bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$newPath = (($userPath -split ';') | Where-Object {
  $_ -and $_.TrimEnd('\\') -ne $binDir.TrimEnd('\\')
}) -join ';'
[Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
Remove-Item -LiteralPath (Split-Path $binDir) -Recurse -Force
```

Open a new terminal after changing `PATH`. If you installed to a custom
`SHOWTAIL_BIN_DIR`, substitute that directory.

## 3. Decide what data to keep

Project trails live in each project's `.showtail/` directory. They are user data
and are never deleted by uninstalling the program.

Machine-local state and the durable session ledger live in `~/.showtail-cli/`.
Delete that directory only if you no longer need pending or unassigned capture
history:

```powershell
Remove-Item -LiteralPath (Join-Path $HOME '.showtail-cli') -Recurse -Force
```

Review and remove individual project `.showtail/` directories separately if you
also want to delete their recorded trails.
