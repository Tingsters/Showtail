# Sharing your work safely

Showtail keeps a private record of how you worked. What you *share* is a separate,
sanitised report. This page covers how to hand it in, how to attach a summary to a pull
request, and what is checked along the way.

!!! note "The short version"
    1. Work as usual. Nothing sensitive is ever staged by `git add .`.
    2. When you finish, run **`showtail submit`**.
    3. Hand in `showtail-submission/report.html`, like any other assignment.

## Handing in

```bash
showtail submit
```

```text
Report ready: /home/you/hw3/showtail-submission/report.html
  Folder: showtail-submission/  (report.html, report.md, manifest.json, manifest.sig)
  Sanitised: 14 value(s) withheld, then re-checked by an independent scan (clean).
  Fingerprint: sha256:9f2c…
```

`submit` builds the report from your private trail and then:

- masks your own secrets (found in your environment, `.env` files and credential
  files) in any encoding, and removes known key formats, passwords and personal data;
- **withholds any long random-looking token** it does not recognise as ordinary text
  (a word, an identifier, a path, a commit id), so a key format nobody has seen before
  is still removed. Withheld values show as `‹withheld›`; it errs on the side of
  removing too much;
- replaces your machine paths with `~` and `<project>`;
- runs a **second, independent scan** over the result. If that scan finds anything at all,
  `submit` stops, says what *kind* of thing it found (never the value), and writes
  nothing.

If it stops, rotate any key you pasted into a prompt and run `submit` again.

The folder it writes sits *outside* `.showtail/`:

| File | What it is |
| ---- | ---------- |
| `report.html` | The report to open or hand in. |
| `report.md` | The same report as Markdown. |
| `manifest.json` | File hashes, counts, what was withheld (labels and counts only). |
| `manifest.sig` | A signature over the manifest. |

`showtail report` still exists: it makes your own **full, private** copy under
`.showtail/reports/`. Never hand that one in.

## Checking a submission

```bash
showtail verify-submission            # ./showtail-submission
showtail verify-submission path/to/folder
```

This confirms the report files are unchanged since they were signed, and scans the text
again. The signature is made with a key Showtail creates for you the first time you run
`submit`, kept in your private Showtail folder (never in a repository).

!!! warning "What this proves, and what it doesn't"
    It proves the files were **not edited after `showtail submit`**. It does **not** prove
    who made them, and it cannot tell whether someone wrote the prompts themselves. It is
    a check on the file, not on the person. Anyone can generate their own key.

An educator does not need Showtail to *read* `report.html`; it is a normal web page.
Showtail is only needed to run `verify-submission`.

## A summary on your pull request

If you are working on a pull request, you can attach a short summary:

```bash
showtail submit --pr --preview     # shows the exact comment; posts nothing
showtail submit --pr --approve a1b2c3d4   # posts exactly that text
```

The comment is a **summary**, never the report: how many exchanges, which files changed,
when you worked, a few prompt excerpts, and the report's fingerprint (so your instructor
can compare it with the file you handed in). It is built only from already-sanitised data
and scanned again.

- **You always see the exact text first.** `--preview` prints it, and tells you whether
  the repository is public. A comment on a public repository is **public and permanent**,
  and edits stay visible in its history, so Showtail posts once and never edits.
- **Approval is tied to that exact text.** The code `--preview` prints belongs to the text
  you were shown. If the report changes after the preview, the approval no longer works.
  Run the preview again.
- **Interactive?** Run `showtail submit --pr` in a terminal and it just asks *Post this
  comment? [y/N]*.
- It uses your own `gh` login (run `gh auth login` once). Pass a number or URL to target a
  specific pull request: `showtail submit --pr 7`.

When an AI assistant helps you open a pull request, it will **ask first** whether to add
this summary, show you the full text, and wait for your yes. It never posts on its own.

## Working with teammates on GitHub

Commit the **submission folder**, not the working trail:

```bash
showtail submit
git add showtail-submission
git commit -m "Showtail report"
```

A guard that Showtail installs in your repository checks `showtail-submission/` before it
is committed, and refuses it if it has been edited since it was signed or no longer scans
clean. It also refuses `.showtail/` itself, even with `git add -f`
(see [Privacy](privacy.md#committing-showtail)). To keep a stray `git push` from carrying
the working trail, the same guard runs on push.

The guard blocks only on its own refusal. If `showtail` is missing or out of date on a
machine, your commits are never blocked because of it.

## Installing safely

The installers check what they download against the `SHA256SUMS` file published with each
release, and refuse to install on a mismatch or when the file is missing (see
[Installation](../getting-started/installation.md)). Windows releases are code-signed; see
the [code signing policy](../code-signing-policy.md) for the current status.

Those checks catch a download that was corrupted or altered in transit. A checksum file
published next to the binary cannot, on its own, protect against someone who can replace the
release itself, because they could replace the checksums too; signing is what covers that.

## What Showtail will not do

- It will not publish your working trail, or let `git add .` do it.
- It will not post anywhere without showing you the exact text and getting your approval.
- It will not claim redaction is perfect. A low-entropy password typed in plain prose, with
  no label, that is not on your machine, is the one thing it cannot reliably find.

If you pasted a real key, **rotate it**. The provider already has it.
