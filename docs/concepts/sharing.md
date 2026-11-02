# Sharing your work safely

Run `showtail report` to review privately. Run `showtail submit` to create what you hand in.
Submissions live under `~/.showtail/exports/<id>/` and contain `report.html`, `report.md`,
`manifest.json`, and `manifest.sig`. Share that export folder, never the private history,
identity, signing key, pending queue, or private reports.

Submission data is sanitized and independently scanned before rendering and signing.
Captured plans and diffs are embedded; no project-folder layout or local file links are
required. Run `showtail verify-submission <folder>` to check signatures and content hashes.
This demonstrates export integrity, not the signer's identity or the completeness of work.

For a pull request, preview with `showtail submit --project <id> --pr <url> --preview`.
Showtail displays the entire proposed comment, withheld count, and repository visibility.
Only `showtail submit --pr --approve <code>` posts that exact stored text. A changed
report or history invalidates approval. Public PR comments are public and permanent.
