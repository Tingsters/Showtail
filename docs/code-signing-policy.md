# Code signing policy

## Status and scope

Showtail is preparing to enroll in the SignPath Foundation Open Source Code
Signing program. Current releases must be treated as unsigned unless their
individual GitHub release notes explicitly say otherwise.

After enrollment, `showtail-windows-x64.exe` will be the only artifact signed by
this policy. The PowerShell installer, VS Code extension, Linux binaries, and
macOS binaries are not covered by the Windows Authenticode signature.

**Planned signing service:** Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

The status on this page will change to **active** before the first signed release
is published. Existing releases will not be retroactively signed.

## Build and approval policy

- Release binaries are built from the tagged source by the public GitHub Actions
  workflow in the Showtail repository.
- Release tags must use `vMAJOR.MINOR.PATCH`, match the source version, and point
  to a commit on the protected `main` branch.
- All jobs leading to a signing request run on GitHub-hosted runners.
- The unsigned Windows executable is uploaded directly from the build before it
  is submitted to SignPath. It is never replaced by a locally uploaded binary.
- Every signing request requires approval by a human approver in SignPath.
- A failed, rejected, or unverifiable signing request prevents publication; the
  release workflow has no unsigned Windows fallback.

The SignPath artifact configuration enforces the product name `Showtail` and a
product/file version equal to the release version in Windows four-part form
(`MAJOR.MINOR.PATCH.0`) before applying Authenticode.

## Team roles

- Authors, committers, and reviewers:
  [Cassandra (`Tingsters`)](https://github.com/Tingsters) and
  [Stephen (`steveonjava`)](https://github.com/steveonjava)
- Signing approvers:
  [Cassandra (`Tingsters`)](https://github.com/Tingsters) and
  [Stephen (`steveonjava`)](https://github.com/steveonjava)
- Automated submitter: the release workflow's restricted SignPath CI account;
  it cannot approve signing requests

Both maintainers use multi-factor authentication for repository access and will
use multi-factor authentication for SignPath access.

## Privacy

Showtail does not send captured prompts, edits, reports, analytics, or telemetry
to the maintainers or any service. Network access occurs only for operations the
user or installer initiates, such as installation and upgrades from GitHub,
importing a user-supplied ChatGPT or Gemini share link, optional identity lookup
through GitHub CLI, or installing an editor extension. See the full
[Privacy and redaction policy](concepts/privacy.md).

## System changes and removal

The installer downloads the executable and bundled editor extension, adds the
installation directory to the user's `PATH`, creates machine-local Showtail
state, and may connect detected AI tools for local capture. These changes and
the opt-out are described before the installation command on the
[Installation](getting-started/installation.md) page.

Complete removal instructions are available on the
[Uninstallation](getting-started/uninstallation.md) page.

## Verifying a signed release

After signing is active, verify the downloaded executable in PowerShell:

```powershell
$signature = Get-AuthenticodeSignature .\showtail-windows-x64.exe
$signature.Status
$signature.SignerCertificate.Subject
```

`Status` must be `Valid`, and the subject must identify `SignPath Foundation`.
Compare the file's SHA-256 digest with `SHA256SUMS` from the same GitHub release.

## Policy violations

The maintainers will assist SignPath Foundation with verification, investigation,
and root-cause analysis of any suspected policy violation. Reports involving a
SignPath Foundation signature may also be sent to `support@signpath.io` with the
affected file, release URL, and supporting evidence.
