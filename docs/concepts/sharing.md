# Sharing your work safely

Run `showtail report` to review privately. Run `showtail submit` to create what you hand in.
Submissions live under `~/.showtail/exports/<id>/` and contain `report.html`, `report.md`,
`manifest.json`, and `manifest.sig`. Share that export folder, never the private history,
identity, signing key, pending queue, or private reports.

Submission data is sanitized and independently scanned before rendering and signing.
Captured plans and diffs are embedded; no project-folder layout or local file links are
required. Run `showtail verify-submission <folder>` to check signatures and content hashes.
This demonstrates export integrity, not the signer's identity or the completeness of work.

HTML reports open directly from disk and include their content in one file.
The reader shows ten exchanges per page, with ordinary document scrolling and
navigation that moves into a menu on smaller windows. Several exchanges can be
open at once. Plans, sessions, and file observations have separate paged indexes;
exchanges can be grouped by time or session. Consecutive tool calls stay in compact
groups, and long output and diffs have text pages and full-item downloads.

The overview and session summaries show recorded AI working time and token usage,
including how many exchanges supplied those measurements. Working time sums reported
turn durations; it is not elapsed project time. Missing measurements are distinct
from captured zeroes. Plan approval status and revision feedback remain attached
to each plan, with links back to its source exchange when available.

Use the report's search field to search all included content; the browser's Find
command searches only the currently displayed portion. Expand and print controls
apply to the current reader page. Markdown and JSON retain the complete history.

Detailed HTML browsing requires JavaScript and a browser supporting native gzip
decompression. Without it, the report retains its overview and first prompt page.
The complete Markdown copy remains available in the report or export directory.
Submission verification checks decoded content as well as signatures, including
content that has not been opened in the viewer.

For a pull request, preview with `showtail submit --project <id> --pr <url> --preview`.
Showtail displays the entire proposed comment, withheld count, and repository visibility.
Only `showtail submit --pr --approve <code>` posts that exact stored text. A changed
report or history invalidates approval. Public PR comments are public and permanent.
