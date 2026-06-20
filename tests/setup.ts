import { tmpdir } from 'node:os';

// Cap `findRoot`'s upward walk at the OS temp dir for the entire test run. Test
// temp dirs are created under `tmpdir()` (see makeTempDir), which itself sits
// under the developer's home — so without this boundary an in-process `findRoot`
// on an uninitialized temp dir (e.g. requirePaths) would escape the sandbox and
// resolve the developer's real `~/.showtail`, both failing locally and polluting
// the live trail. Spawned CLIs get the same boundary via spawnEnv() in
// tests/helpers.ts. Honor an externally-set value (e.g. CI) if present.
process.env.SHOWTAIL_ROOT_CEILING ??= tmpdir();
