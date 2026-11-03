Use `showtail submit --project "<id>" --json` to create a sanitized, scanned,
signed submission. Open only its returned `reportPath`. Handing it in is manual.
Check an export with `showtail verify-submission <returned-directory>`.

Only prepare a PR summary when the user explicitly requests one. Run
`showtail submit --project "<id>" --pr --preview`. Show the entire returned comment,
the withheld-value count, and whether posting is public and permanent. Ask for
approval of that exact text. Only then run `--pr --approve <returned-code>`.
Never approve changed or refused previews or edit an export to bypass its scan.
