# How it works

A user-level hook or editor integration reads the prompts, responses, decisions, plans,
and file edits the host exposes. Showtail applies capture settings and redaction, then
writes them once to a central SQLite history. Tool retries and transcript catch-up share
source identities, so reading the same conversation again does not duplicate it.

A project is an optional view over that history. Git roots, development markers, and
host workspace context suggest membership. Work spanning projects can appear in several
views without being copied; folderless conversations are retained too. Manual assignment
changes metadata, never the recorded source paths or content.

Reports group captured records into conversations and turns. Captured plans and diffs
are embedded, so reviewing old work does not depend on its project folder still existing.
`report` is private. `submit` sanitizes selected report data, scans it independently,
and signs a manifest before producing a shareable folder.

Hash chains and content addresses detect inconsistent or altered stored data. Local
verification does not prove authorship, completeness, or that history was never rebuilt.
Submission signatures show that exported files are unchanged since signing, not who signed.
