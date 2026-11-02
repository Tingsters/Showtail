# Verify submissions in CI

Check a submitted export rather than a private working trail:

```bash
showtail verify-submission path/to/submitted-export --json
```

A nonzero exit means the signature, file hashes, or residual scan failed. A valid
submission shows that its exported files are unchanged since signing; it does not prove
who signed it, that all work was captured, or that no earlier history was rewritten.
Never upload a student's complete `~/.showtail` directory to CI.

To use the composite action, copy the reviewed export into the submitted repository:

```yaml
- uses: actions/checkout@v4
- uses: Tingsters/Showtail@main
  with:
    path: showtail-submission
```

Pin both actions to reviewed commit hashes for a stable grading workflow. The action
verifies signed exports only; the old `mode: trail` option has been removed.
