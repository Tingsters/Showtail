// A stand-in for the `showtail` CLI used only by the extension-host security test.
// Compiled to a real executable (bun build --compile) so the editor launches it exactly as
// it would launch the real one. It records that it ran, in a log beside itself, then exits 0
// with no output. Two copies exist in the test: one on PATH, one planted in the workspace.
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

appendFileSync(join(dirname(process.execPath), 'calls.log'), `${process.argv.slice(2).join(' ')}\n`);
