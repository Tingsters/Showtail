# Privacy &amp; redaction

Showtail is privacy-first by design:

- **Everything is local, and the trail is private by default.** Resolved work lives
  in the project's `.showtail/` trail. Work that does not yet have one safe project
  destination waits in the machine-local ledger/inbox under `~/.showtail-cli/` (or
  `SHOWTAIL_HOME`). `.showtail/` ignores itself in git, so a plain `git add .` can
  never publish your raw prompts, the AI's replies or your code diffs. What you hand
  in is a separate, sanitised report from `showtail submit` (see
  [Sharing your work safely](sharing.md)).
- **No telemetry, analytics, or automatic upload of your trail.** Captured
  prompts, edits, reports, and project data are not sent to Showtail's
  maintainers or to a Showtail service.
- **Network access is narrow and documented.** Interactive commands may request
  public release metadata from GitHub at most once per day so Showtail can mention
  an available update. The request sends no trail, prompt, filename, project, or
  identity data; disable it with `showtail update --auto-check off` or
  `SHOWTAIL_DISABLE_UPDATE_CHECK=1`. The installers and `showtail update` download
  releases from GitHub; importing a ChatGPT or Gemini share link fetches that link;
  first-run identity discovery may invoke your authenticated GitHub CLI; and
  extension installation may contact the editor's marketplace when no bundled
  VSIX is available. These operations are not telemetry and do not upload a
  `.showtail/` trail.
- **You control what is recorded.** Installation enables supported capture
  integrations by default. Use `showtail setup --off` to stop automatic project
  creation, or `showtail disconnect <tool>` to stop a tool's capture integration.
- **Secrets are kept out in layers, and described honestly.** See
  [How secrets are kept out](#how-secrets-are-kept-out). No scrubber is perfect, so
  the design does not rest on one: what cannot be made safe is never captured, and
  what you share is checked twice. Tune the capture-time pass under `settings.redact`
  in `config.json` (see [Configuration](../reference/configuration.md#redaction)).
  When something is missed anyway, `showtail redact` cleans it out after the fact — see
  [If something leaked anyway](#if-something-leaked-anyway).
- **The files are plain and inspectable.** They are JSON and JSONL files that
  you can open in any editor.

## How secrets are kept out

A provider changing its key format must not become a leak, so the layers do not all
depend on recognising what a key looks like.

1. **Never captured.** The *output* of tool calls (what `cat .env` or `printenv`
   printed) is not recorded, only the command, and structured tool results keep their
   exit status but not their `stdout`, `stderr` or content. Credential files (`.env*`,
   `*.pem`, `id_rsa`, `~/.aws/credentials`, `.npmrc`, Terraform state, service-account
   JSON, …) are never captured: no diff, no hash, no content. Edits outside your
   project are not snapshotted.
2. **Your own secrets, in any format.** Showtail reads the secret values on your
   machine (secret-named environment variables, your project's `.env` files, and the
   standard credential files) and masks every exact occurrence, raw or URL-encoded,
   base64, or JSON-escaped. This works for a key format that did not exist yesterday.
3. **Known formats and labels.** Provider key formats (OpenAI, Anthropic, AWS, GitHub,
   Stripe, Hugging Face, …), private keys (even a truncated block), `NAME=value` lines
   such as `DB_PASSWORD=…`, bearer/basic auth and passwords in URLs.
4. **Anything that looks random, when you share.** `showtail submit` withholds any long
   opaque token that is not recognisably ordinary (a word, an identifier, a path, a
   commit id, a UUID, a version). Secrets are random strings, so this holds for formats
   nobody has seen. It over-redacts on purpose.
5. **A second, independent check.** Before anything is written for sharing, a separate
   scanner looks over the result. If it finds anything, `submit` stops and writes
   nothing.

What no tool can promise: a low-entropy password you typed in plain prose, with no
label, that is not on your machine ("it's purple elephant"). Keep those out of prompts.

!!! danger "If you pasted a real key into a prompt, rotate it now"
    Whatever Showtail hides afterwards, **the AI provider already received it**. Hiding
    it from your record does not make it safe. Revoke the key and make a new one. On a
    public repository a leaked key can be found and abused within minutes, and deleting
    a commit does not help, because forks and cached views keep it. Rotating is the only
    fix. It also helps to set a spending limit on every API key you use.

## Local project-selection metadata

To keep project controls from following a stale editor workspace, Showtail maintains a small
machine-local catalog keyed by each trail's generated ID. It contains known current/previous
paths, project/folder names, edit-backed ledger references, and local selection bindings. None of
this catalog is written into a project report or uploaded.

The VS Code integration reads only allowlisted fields from the local chat files it already
captures: native session/request IDs, explicitly attached file URIs, edit URIs, and Showtail's own
versioned tool-result marker. It does not inspect VS Code's `state.vscdb`, shell history,
recent-file database, or private Copilot SQLite stores. Automatically attached instructions,
workspace paths, generated titles, and recency cannot select a project by themselves.

Recorded file hashes may validate an already supplied move candidate, but Showtail does not scan
the machine for matching hashes or treat a hash as evidence of the student's current intent.

## If something leaked anyway

Write-time redaction is a safety net, and safety nets have holes: a credential in
a format the rules do not know yet goes into the content-addressed object store
and stays there. You should not have to delete `.showtail/` — and lose your whole
trail — because you pasted a key once. Use `showtail redact`.

```bash
# Preview: what would the current rules remove from everything already stored?
showtail redact --rescan --dry-run

# Apply the current rules (including any settings.redact.custom you added since).
showtail redact --rescan

# Scrub one specific thing you know leaked. This previews by default;
# --yes applies it.
showtail redact --pattern 'dop_v1_[0-9a-f]{32}'
showtail redact --pattern 'dop_v1_[0-9a-f]{32}' --yes
```

A pass rewrites the stored content, files it under its new address, repoints the
journal entry at it, and **deletes the object the secret lived in**. It uses the
same rule engine as capture, so a `settings.redact.custom` pattern you add today
applies retroactively to work captured last week.

### The pass is recorded, on purpose

Rewriting stored content changes the trail's history, and the journal's hash
chain is re-linked so the result still verifies. That is necessary — otherwise a
legitimate scrub would look exactly like tampering — but it would also make the
rewrite invisible. So every pass appends a dated **redaction marker** to the
journal: when it ran, how many entries it touched, how many values it removed,
and which rule labels fired. `showtail verify` prints it beside the chain result:

```text
PASS  journal chain is unbroken
        chain intact; 7 chained journal entries verified.
        1 recorded redaction pass (`showtail redact` removed stored content on
        purpose and re-linked the chain):
          2026-07-25T09:14:02.881Z — pattern: 1 entry rewritten, 1 value(s) removed (pattern).
```

The marker never stores a removed value — nor the `--pattern` you used, since a
pattern is often the secret itself.

`showtail import undo` records the same kind of marker (`reason: import-undo`),
for the same reason: it drops a batch of entries and re-links the chain, which
is also a rewrite. In a git repository these markers do more than disclose —
`verify` reconciles them against the rewrites git history shows, and reports any
rewrite no marker accounts for. See
[Why the trail is hard to fake](how-it-works.md#why-the-trail-is-hard-to-fake).

!!! warning "What the marker is and is not"
    It is an honest disclosure that history was rewritten, not cryptographic
    proof of *which* rewrites happened. The chain check only proves the journal
    is internally consistent, and anything that can write the folder can produce
    a consistent journal. What the marker never does is *excuse* a break: an edit
    made by hand still breaks the following entry's link, and `verify` still
    reports it as unexplained whether or not a marker sits next to it.

## Committing `.showtail/`

By default, don't. The working trail holds your raw prompts, the AI's replies and your
code diffs, so `.showtail/` ignores itself, and a `pre-commit` / `pre-push` guard that
Showtail installs refuses to commit it even with `git add -f`. To share your work, use
`showtail submit`: it writes a sanitised report you can hand in or attach to a pull
request. See [Sharing your work safely](sharing.md).

If `.showtail/` was already committed before you updated, stop tracking it with
`git rm -r --cached .showtail`. That does not remove it from earlier commits: if it held
a secret, rotate the secret.

### Educators who want the trail itself in git

A course repository can opt in with `"commitTrail": true` under `settings` in
`.showtail/config.json`. Then everything under `.showtail/` is committed (teammates'
trails merge through git, and the [GitHub Action](../educators/verify-in-ci.md) and
`showtail verify` can use git history as an outside anchor). The trade-off is the whole
point of the default: the trail is only as safe as capture-time redaction, which is
best-effort. Tell students plainly that their prompts become part of the repository.

## External services

Showtail does not operate a cloud service. User-initiated features may interact
with services operated by third parties, subject to their privacy policies:

- [GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)
  for installation, public release checks, updates, and optional identity lookup
  through GitHub CLI, and, only after you approve the exact text, posting a
  pull-request summary with `showtail submit --pr` (through your own `gh` login).
- [OpenAI](https://openai.com/policies/privacy-policy/) when you import a
  user-supplied ChatGPT shared conversation.
- [Google](https://policies.google.com/privacy) when you import a user-supplied
  Gemini shared conversation or install into Antigravity.
- [Microsoft](https://privacy.microsoft.com/privacystatement) when an editor
  contacts the Visual Studio Marketplace to install the Showtail extension.

Showtail reads local configuration and transcripts created by supported AI tools,
but it does not make model API requests on their behalf.
