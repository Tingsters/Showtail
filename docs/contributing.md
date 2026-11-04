# Contributing and development

Use Bun to install dependencies, run checks, and compile the CLI:

```bash
bun install
bun run typecheck
bun test
bun run verify:integrations
bun run build
```

Tests isolate Showtail and tool homes under temporary directories. Provider fixtures
exercise normalized capture without contacting AI accounts. The central tests check
content integrity, contention replay, consent boundaries, explicit migration, signed
exports, and byte-for-byte project preservation. Provider fixture verification is
not a claim that a live vendor integration was exercised.

The VS Code extension has separate dependencies and checks in `integrations/vscode`:
`bun install`, `bun test`, `bun run typecheck`, and `bun run build`. Its extension-host
suite additionally requires a usable editor environment.

Use an isolated absolute `SHOWTAIL_HOME` when developing. Never point tests at your
personal history. Legacy fixtures are read-only inputs. Update the capability table
with `bun run scripts/update-matrix.ts` after changing capability metadata.

Documentation uses MkDocs; see `mkdocs.yml`. Changes are licensed under Apache-2.0.

## Acceptance testing

Use the Bun version in `.bun-version` (currently 1.4.0) for acceptance orchestration
and live-agent terminal sessions. The report browser checks run in a separate
**real Node.js 20 or newer** worker with Playwright Chromium. This avoids observed
Windows browser-pipe hangs under Bun, including Bun 1.4. Node and Chromium are
acceptance-test dependencies.

The browser worker searches for a real Node runtime in this order:

1. `SHOWTAIL_ACCEPTANCE_NODE_BIN`, when supplied.
2. `node` on `PATH`.
3. On Windows, the user-installed VS Code `Code.exe` under
   `%LOCALAPPDATA%/Programs/Microsoft VS Code`.

The VS Code fallback runs with `ELECTRON_RUN_AS_NODE=1` in the worker process.
It does not open an editor window. Other installations can be selected explicitly,
for example in PowerShell:

```powershell
$env:SHOWTAIL_ACCEPTANCE_NODE_BIN = 'C:\Program Files\nodejs\node.exe'
```

`browser-runtime.json` records the runtime selected for each report inspection.

```bash
bun x playwright install chromium
bun run test:acceptance --binary /absolute/path/to/showtail
bun run test:acceptance:live --binary /absolute/path/to/showtail
```

The default acceptance command runs deterministic, offline checks through the
compiled executable and Chromium. Its rich report fixture checks the initial
multiline prompt, repeated human prompts, applied revision counts, real report
controls, long narration, 320px layout, signed exports, tamper rejection,
idempotency, and project relocation. It never contacts an AI provider. CI runs
this lane alongside the regular tests and the real editor-host watcher checks.

The explicit `:live` command additionally uses authenticated Codex and Claude Code
sessions in disposable projects and isolated tool/Showtail homes. It checks real
interactive lifecycle delivery before any sync or report command, then separately
checks catch-up. Ordinary task prompts do not mention Showtail. Existing personal
settings and history are not test inputs. Credentials are scoped to the provider
and necessary collection processes and are excluded from browser workers and
evidence files.

Codex OAuth credentials are copied alone into a private temporary profile and
removed when its scenario finishes; personal configuration, hook trust, and native
history are never copied. Claude uses the existing `ANTHROPIC_API_KEY` only in its
test process tree. Normal Codex hook review is automated only for the test's own
temporary hooks.
The child environment disables Claude's background updater with
[`DISABLE_AUTOUPDATER`](https://code.claude.com/docs/en/setup#disable-auto-updates)
so test sessions do not initiate provider upgrades.

Live runs default to Codex's `workspace-write` sandbox. Current Windows unelevated
sandboxing can reject split writable roots before the task executes. For a trusted
local test run matching a full-access developer environment, select
`--sandbox danger-full-access` explicitly. The chosen mode is recorded in receipts.
Use `--provider codex`, `--scenario shell`, or `--repetitions 1` to diagnose a subset;
filtered runs are labeled partial coverage. Individual turn watchdogs can be set
with `--turn-timeout <milliseconds>`; there is no overall suite time cap.
Each scenario runs in a fresh process, isolating terminal handles and CLI checks;
the two provider lanes can run independently. A separate scenario runs both agents concurrently against one
project. A native provider `server_overloaded` failure gets one fresh retry;
the original failed attempt and retry decision are retained in the receipts.

Receipts under `dist/acceptance/<run-id>` identify the executable hash, provider
versions, expected/observed prompts and actions, per-phase results, reports and
screenshots. A passing fixture or editor-watcher test does not certify a live
provider session. Missing authentication and unsupported host modes remain
explicit incomplete coverage, rather than being counted as passes. Keep failed
attempts when fixing and rerunning a scenario; do not replace them with later
successes. A complete claim needs a fresh passing run of the final executable.

For report changes, also run the deterministic report acceptance lanes:

```bash
bun run test:acceptance:parity dist/acceptance/parity
bun run test:acceptance:large dist/acceptance/large
SHOWTAIL_ACCEPTANCE_BROWSER=firefox bun run test:acceptance:large dist/acceptance/large-firefox
SHOWTAIL_ACCEPTANCE_BROWSER=webkit bun run test:acceptance:large dist/acceptance/large-webkit
SHOWTAIL_ACCEPTANCE_CPU_RATE=4 bun run test:acceptance:large dist/acceptance/large-throttled
```

Install those browser engines with `bun x playwright install firefox webkit`.
The fixture keeps 181 prompts and 4,720 distinct revisions, with long output and
a search match across text-page boundaries. It also includes approved, revised,
and unlinked plans; multiple contributors and models; captured zero and missing
usage; tool failures; and Markdown that crosses text-page boundaries.
The browser inspector independently decodes every prompt/revision before
exercising page navigation, late search,
worker-disabled fallback, keyboard focus, offline copying and mobile layout.
Visible parity checks open the actual Plans, Sessions, and Overview views, read
statistics and revision feedback, change grouping and AI display, and exercise
ordinary document scrolling at phone, tablet, and desktop sizes. Encoded content
alone cannot satisfy those checks. It checks mounted-DOM and decoded-cache limits;
browser timing measurements are recorded separately from fixture completeness.
Private real-project benchmarks
must remain outside tracked fixtures.

## AI visual review loop

The report audit captures actual reading states and runs browser tasks, layout
assertions, and axe accessibility checks. It uses the same real-Node transport as
the other acceptance lanes. The accessibility library is a development dependency;
it is never loaded by the distributed report or CLI.

```bash
bun run test:report:audit --fixture parity --artifact-dir dist/acceptance/audit-small-01
bun run test:report:audit --fixture large --artifact-dir dist/acceptance/audit-large-01
bun run test:report:audit --fixture empty --artifact-dir dist/acceptance/audit-empty-01
SHOWTAIL_ACCEPTANCE_BROWSER=webkit bun run test:report:audit --fixture parity --artifact-dir dist/acceptance/audit-webkit-01
bun run test:report:audit --report /absolute/private/report.html --artifact-dir /absolute/private/audit-01
```

An existing report requires its adjacent `report.json`. The audit reads the report
without regenerating it or modifying its source project. Existing-report inputs
are refused in CI. Keep private screenshots, traces, JSON and HTML outside tracked
fixtures and public artifact roots. CI uses synthetic fixtures exclusively and
retains its named public audit artifacts for 14 days.

Choose a new artifact directory for every iteration. `result.json` records the
input hashes, environment, automated checks, and incomplete runs. `visual/review.html`
contains viewport screenshots of open plans, session statistics, exchanges, code,
and diffs as well as navigation and controls. Failed tasks retain a browser trace.
Missing required screenshots, accessibility violations, browser failures, and
layout regressions produce a nonzero exit status. Uncertain accessibility findings
remain visible for review; they are not automatically certified.

During an AI coding session:

1. Freeze the input report JSON and capture a baseline. Use both the synthetic
   fixtures and a private, representative large report such as Tracetoon.
2. Open the actual screenshots with the host's image tool. Review desktop, tablet,
   phone, short-window and dark views, including scrolled reading positions.
   Exercise visible controls and keyboard tasks; do not bypass navigation by
   modifying application state.
3. Record concrete findings in `visual-review.json`, including screenshot names,
   severity, the observed problem, and the intended improvement. Automated success
   leaves this review pending; it is not a visual approval.
4. Fix one coherent problem, add an appropriate regression assertion, and compare
   matching before/after states using identical input data. Retain failed attempts.
5. Run all browser lanes and perform two complete visual review passes without
   new major usability findings. Record the actual reviewer, inspected states,
   resolved findings and remaining observations against the report hashes.

Preserve the reading-first structure, complete evidence, Plans, session grouping,
usage statistics, and offline behavior. The reference 390 × 844 unfiltered phone
view must place its first exchange within 60% of the initial viewport. Keep one
vertical scroll owner, working keyboard access to overflowing content, readable
previews, and concise status signals. Screenshot pixel baselines are not used;
review the images and measured geometry rather than approving a changed picture
automatically. Scripted click counts describe interactions, not user comprehension.
