# Verify submissions in CI

Showtail ships a **GitHub Action** so every push to a student's assignment repo
is checked automatically: the trail is either provably unmodified, or the check
goes red with a plain-English reason in the **Checks** tab.

Drop it into your assignment template repo once, and every submission generated
from that template (GitHub Classroom or a plain template repo) inherits it.

## The workflow file

Create `.github/workflows/showtail.yml` in your assignment **template** repo:

```yaml
name: Showtail

on:
  push:
  pull_request:
  workflow_dispatch:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Tingsters/Showtail@v1
```

That's the whole thing. The action installs the `showtail` binary, runs
`showtail verify --json` at the repo root, writes a pass/fail summary to the job
summary, and fails the job if the trail does not verify.

!!! warning "Not usable until the next release"

    This action needs `showtail verify --json`, which landed after v0.12.0 — the
    current latest release does not have it, and the action fails with
    `unknown option '--json'` against it. The `v1` tag it references does not
    exist yet either (releases are tagged `v0.x`). Both are resolved by cutting
    the next release and pointing a `v1` tag at it; until then this page
    describes what will work, not what does.

`@v1` follows the v1 major tag, so bug fixes reach your classes without you
editing anything; pin a release tag or a commit SHA instead if you'd rather
freeze it for a term.

!!! note "Students must commit `.showtail/`"

    The trail is only checkable if it is in the repo. Step 4 of the
    [classroom workflow](classroom-workflow.md) covers this — reports are
    regenerable and git-ignored, but `.showtail/` itself must be committed.

## Inputs

| Input | Default | What it does |
| ----- | ------- | ------------ |
| `path` | `.` | Directory holding the submission — the folder containing `.showtail/`. Use it when the project lives in a subfolder. |
| `version` | `latest` | Which Showtail to install: `latest`, or a tag from the [releases page](https://github.com/Tingsters/Showtail/releases). Pin a tag if you want every submission graded by exactly the same version — but only tags that ship `verify --json` work here, so keep `latest` unless you have a reason to pin. |
| `fail-on-invalid` | `true` | Set to `false` to report the result without failing the job — useful early in a term, when you want the signal but not a red X. |

```yaml
      - uses: Tingsters/Showtail@v1
        with:
          path: assignment
          version: latest
          fail-on-invalid: false
```

## Outputs

| Output | What it is |
| ------ | ---------- |
| `ok` | `"true"` when every check passed, otherwise `"false"`. |
| `checks-json` | The raw [`verify --json`](../reference/cli.md#verify-json) result: `{"ok":…, "checks":[{"name","ok","details"}]}`. |

Use them in a later step — for example, to leave a comment or set a label:

```yaml
      - uses: Tingsters/Showtail@v1
        id: showtail
        with:
          fail-on-invalid: false

      - name: Report
        if: steps.showtail.outputs.ok != 'true'
        run: |
          echo "The trail did not verify."
          echo '${{ steps.showtail.outputs.checks-json }}' | jq -r '.checks[] | select(.ok | not) | .name'
```

Branch on each check's `name` and `ok`. The `details` lines are human text and
may be reworded between releases.

## Reading the result

The job summary lists every check as `PASS` or `FAIL` with its details, so you
can grade from the Checks tab without opening the logs:

```text
## Showtail trail verification

Project: `.` — Showtail `<version>`

**FAIL — the trail did not verify.** 1 of 7 checks failed:

- journal chain is unbroken

### Checks

- **PASS** config.json is present and valid
- **PASS** journal entries are valid
- **FAIL** journal chain is unbroken
  - ada-at-example-com/9f3c… entry 12 (evt_lqz3k8_a1b2): the entry before it
    does not match this entry's recorded link — the journal was edited after it
    was written.
- **PASS** stored content matches its address
  …
```

**What a failure means:** the recorded trail was **changed after it was
written** — an edited journal line, or stored prompt text that no longer hashes
to its address.

**What it does not mean:** it is *not* a plagiarism verdict, and it is *not*
triggered by a student continuing to work. Editing a source file after its last
snapshot is normal and only ever shows up as information. See
[`verify`](../reference/cli.md#verify-json) for what each check covers.

If the action can't run `showtail verify` at all — usually because `.showtail/`
was never committed — the job fails with that message instead, whatever
`fail-on-invalid` says.

## What it does to the runner

Nothing that outlives the job. The binary is installed into `RUNNER_TEMP`, and
the action sets `SHOWTAIL_DISABLE_FIRST_RUN=1` plus scratch `SHOWTAIL_HOME` /
`SHOWTAIL_IDENTITY_HOME` values, so Showtail's normal "turn capture on and wire
up your AI tools" bootstrap never fires on a CI machine. Verification only
reads the trail.

## See also

- [Example classroom workflow](classroom-workflow.md) — where this fits in the term.
- [CLI reference](../reference/cli.md#verify-json) — the checks and exit codes behind it.
- [Working as a team](teams.md) — group repos verify the same way; every author's
  trail is checked.
