import { afterEach } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Give in-process tests a deterministic student identity so `runInit` and the
// hooks can establish an author folder without prompting or shelling out to
// gh/git. `SHOWTAIL_IDENTITY_HOME` keeps the machine-identity cache inside the
// OS temp dir, never the developer's real `~/.config/showtail`.
process.env.SHOWTAIL_IDENTITY_EMAIL ??= 'tester@example.com';
process.env.SHOWTAIL_IDENTITY_NAME ??= 'Test Student';
process.env.SHOWTAIL_IDENTITY_HOME ??= join(tmpdir(), 'showtail-test-identity');

// Isolate the machine-global durable ledger (`SHOWTAIL_HOME`) for the whole test
// run, so hooks never write to the developer's real `~/.showtail-cli/ledger`.
// Spawned CLIs inherit it through `spawnEnv()`'s `...process.env`; tests that pin
// their own home via `envWithHome` override it per test.
process.env.SHOWTAIL_HOME ??= join(tmpdir(), 'showtail-test-home');

// Clear the shared machine-global state after each test. The per-project `.showtail/`
// is already isolated by its temp dir, but the ledger AND global config live under
// `SHOWTAIL_HOME`: tests reuse native session ids (e.g. `sess-1`) so ledger records
// would leak, and global config keys (`captureSince`, `autoInit`) written by one test
// (e.g. `setup`) would leak into the next and change surfacing/backfill behavior.
// Best-effort; never throws.
afterEach(() => {
  const home = process.env.SHOWTAIL_HOME ?? '';
  try {
    rmSync(join(home, 'ledger'), { recursive: true, force: true });
    rmSync(join(home, 'config.json'), { force: true });
  } catch {
    /* ignore */
  }
});

// Cap `findRoot`'s upward walk at the OS temp dir for the entire test run. Test
// temp dirs are created under `tmpdir()` (see makeTempDir), which itself sits
// under the developer's home — so without this boundary an in-process `findRoot`
// on an uninitialized temp dir (e.g. requirePaths) would escape the sandbox and
// resolve the developer's real `~/.showtail`, both failing locally and polluting
// the live trail. Spawned CLIs get the same boundary via spawnEnv() in
// tests/helpers.ts. Honor an externally-set value (e.g. CI) if present.
process.env.SHOWTAIL_ROOT_CEILING ??= tmpdir();

// Isolate the Gemini/Antigravity config home (`~/.gemini`) for the whole test
// run. The Antigravity IDE and Gemini CLI plugins resolve hooks/instructions under
// `geminiHome()` (honors GEMINI_HOME). The Antigravity IDE writes its hooks to the
// GLOBAL `~/.gemini/config/hooks.json` for every scope — so without this, an
// in-process connect/uninstall test (plugins.test, capability-backing) would
// mutate the developer's REAL hooks.json: the uninstall step strips the live
// Showtail bundle, silently breaking the dev's own IDE capture. Pin it to a temp
// dir so tests never touch the real file. Spawned CLIs inherit it via spawnEnv();
// per-test overrides (antigravityIde.test) still win. Honor an external value.
process.env.GEMINI_HOME ??= join(tmpdir(), 'showtail-test-gemini');

// Neutralize VS Code detection for the whole test run. The copilot plugin's
// `findVsCodeCli()` probes absolute app-bundle paths (e.g. /Applications/Visual Studio
// Code.app) that escape PATH/HOME isolation — so on a dev machine with VS Code installed
// it would make copilot "detected" in tests that assume an empty PATH means nothing is
// present, and could let an in-process `autoConnect` run a REAL `code --install-extension`.
// Point the override at a nonexistent path so `findVsCodeCli()` returns null unless a test
// opts in by setting `SHOWTAIL_VSCODE_CLI` to its own stub. Honor an external value.
process.env.SHOWTAIL_VSCODE_CLI ??= join(tmpdir(), 'showtail-no-vscode-cli');
