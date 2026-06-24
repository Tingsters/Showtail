import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Give in-process tests a deterministic student identity so `runInit` and the
// hooks can establish an author folder without prompting or shelling out to
// gh/git. `SHOWTAIL_IDENTITY_HOME` keeps the machine-identity cache inside the
// OS temp dir, never the developer's real `~/.config/showtail`.
process.env.SHOWTAIL_IDENTITY_EMAIL ??= 'tester@example.com';
process.env.SHOWTAIL_IDENTITY_NAME ??= 'Test Student';
process.env.SHOWTAIL_IDENTITY_HOME ??= join(tmpdir(), 'showtail-test-identity');

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
