# Uninstallation

Run `showtail disconnect <tool>` for each connected tool to disable capture and remove
its user-level registration. Reload editor windows after removing the extension. Remove
the installed executable using the installation method you originally chose.

Your history remains in `~/.showtail` (or `SHOWTAIL_HOME`) until you deliberately remove
it. Use `showtail home` to confirm its location and back it up first. Uninstalling a host
plugin or disconnecting one tool does not delete Showtail's history.

Older versions may have left `.showtail` folders, instruction blocks, and Git guard
blocks in projects. Setup/connect back up and retire identifiable Showtail instruction
blocks and capture callbacks in known registered projects. Old data folders and Git guard
blocks remain untouched; review legacy import results before removing them manually.
The old guard check is a harmless no-op.

Pause capture with `showtail setup --off` before removing the binary. Windows binaries installed by the installer live in `%LOCALAPPDATA%\Showtail\bin`; remove that directory and its user PATH entry.
