# Privacy and redaction

Showtail is local. Capture is enabled by user-level setup or connections, can be paused
with `setup --off`, and can be stopped per tool with `disconnect <tool>`. Disconnection
preserves history and prevents background recovery from capturing the stopped interval.

Capture settings and best-effort secret/PII redaction run before content reaches the
history database or pending queue. Tool output is withheld by default. Credential-file
contents and Showtail's own data are excluded from edit capture. Diagnostics record issue
categories rather than raw payloads. Do not put secrets in prompts; if you already did,
rotate them, because the AI provider received them before Showtail could redact them.

Private reports are complete local snapshots. `submit` creates a separate sanitized report,
checks it with an independent scanner, and signs a manifest. Review it before handing it
in. Nothing is uploaded automatically. PR comments require approval of their exact text.

`redact --rescan` applies current rules to stored content. `redact --pattern <regex>`
previews a custom rewrite; add `--yes` to apply it. Rewrites leave a counted audit record
and rebuild internal hash chains. Regenerate private report snapshots after a rewrite.
