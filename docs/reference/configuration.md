# Configuration

Settings live in `~/.showtail/config.json`, alongside history and identity. Use an
absolute `SHOWTAIL_HOME` to relocate all Showtail data. Relative overrides are rejected.

```json
{
  "version": 2,
  "captureEnabled": true,
  "settings": {
    "captureAiOutput": true,
    "captureCode": true,
    "captureToolCalls": true,
    "captureToolOutput": false,
    "redact": { "enabled": true, "secrets": true, "pii": true }
  }
}
```

`setup --off` pauses automatic capture globally; `setup` resumes it. Per-tool disconnects
remain disabled until explicitly reconnected. A reconnect boundary prevents importing
previously uncaptured history from the stopped interval. Explicit imports can recover old
conversations at the student's request.

Capture redaction accepts `custom` regular-expression strings and literal `allow` entries.
Sharing always applies its own sanitization and independent scan, regardless of capture
settings. `captureToolOutput` is off by default; answers to student-choice tools are retained.
Project settings and the `commitTrail` option no longer exist.
