# Uninstallation

Run `showtail disconnect <tool>` for each connected tool to disable capture and remove
its user-level registration. Reload editor windows after removing the extension. Remove
the installed executable using the installation method you originally chose.

Your history remains in `~/.showtail` (or `SHOWTAIL_HOME`) until you deliberately remove
it. Use `showtail home` to confirm its location and back it up first. Uninstalling a host
plugin or disconnecting one tool does not delete Showtail's history.

Older versions may have left `.showtail` folders, instruction blocks, and Git guard
blocks in projects. The new runtime does not modify them. Review legacy import results
before removing those old artifacts manually. The old guard check is a harmless no-op.

Pause capture with `showtail setup --off` before removing the binary. Windows binaries installed by the installer live in `%LOCALAPPDATA%\Showtail\bin`; remove that directory and its user PATH entry.
