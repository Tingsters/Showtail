# SignPath configuration

This directory records the reviewed configuration expected in SignPath. The
SignPath service remains the operational source of truth.

- Project slug: `showtail`
- Artifact configuration slug: `windows-exe`
- Signing policy slug: `release-signing`
- Repository: `https://github.com/Tingsters/Showtail`
- Trusted build system: GitHub.com
- Allowed release origin: protected `main`
- Approval process: one approval from a human project approver
- Signed artifact: `showtail-windows-x64.exe`

Create the artifact configuration in SignPath from
`artifact-configuration.xml`. Configure its `version` parameter from the release
workflow as the four-part Windows version `MAJOR.MINOR.PATCH.0`, and do not
weaken its metadata restrictions.

The release workflow is intentionally blocked until all of these repository
settings exist:

- repository variable `SIGNPATH_ENABLED` set to `true`;
- repository variable `SIGNPATH_ORGANIZATION_ID`;
- repository secret `SIGNPATH_API_TOKEN`, owned by a CI user with submitter-only
  access to `release-signing`.

The CI user must not be an approver. Cassandra and Stephen are the human
approvers and must use TOTP for their SignPath accounts.
