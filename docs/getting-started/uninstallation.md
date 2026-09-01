# Uninstallation

Showtail's installer changes only the current user's files and configuration.
Removing the executable alone does not remove capture hooks or editor extensions,
so disconnect those first.

## 1. Stop automatic capture

```powershell
showtail setup --off
```

Disconnect any user-level integrations you enabled:

```powershell
showtail disconnect claude --user
showtail disconnect codex --user
showtail disconnect copilot-cli --user
showtail disconnect antigravity-cli --user
showtail disconnect antigravity-ide --user
```

Run the corresponding command without `--user` inside any project where you
installed project-level integration files. For Copilot project instructions, run:

```powershell
showtail disconnect copilot
```

Remove installed editor extensions when applicable:

```powershell
code --uninstall-extension Tingsters.showtail
antigravity-ide --uninstall-extension tingsters.showtail
```

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
