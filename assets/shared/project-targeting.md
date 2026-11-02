## Project views

All captured work lives in Showtail's central history. A project ID selects a view;
its `projectRoot` is context, not a storage location. Resolve named views with
`showtail projects "<student wording>" --json`, and pass `selection.projectId` to
report and submission commands. Ambiguity requires a local choice. Never change
membership merely because the student requested a different project's report.
Folderless work is selected by session ID; all-history reports require `--all`.

Never choose from the terminal working directory for a named project. Resolve its stable project ID.
