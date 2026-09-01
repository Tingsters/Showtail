# SignPath Foundation application checklist

Do not submit the application until the reputation gate at the end is complete.
The SignPath Foundation retains discretion to reject an application even when
all published requirements are met.

## Public application fields

- Project name: `Showtail`
- Repository URL: `https://github.com/Tingsters/Showtail`
- Homepage URL: `https://tingsters.github.io/Showtail/`
- Download URL:
  `https://tingsters.github.io/Showtail/getting-started/installation/`
- Privacy policy URL:
  `https://tingsters.github.io/Showtail/concepts/privacy/`
- Maintainer type: `Independent community project (no formal organization)`
- Build system: `GitHub Actions`
- Tagline: `Show your work with a local, verifiable record of AI prompts and file changes.`
- Description: use the stable project description from `package.json`; do not
  list version-specific features or dependencies.

Keep applicant names, email addresses, and other personal application data out
of the repository.

## Foundation eligibility audit

- Apache-2.0 is OSI approved and applies to the project and extension; Showtail
  has no commercial dual-license edition.
- `THIRD_PARTY_NOTICES.md` and the release SBOM account for the Bun runtime and
  shipped dependencies; no proprietary component is included in the signed PE.
- Showtail contains no malware, potentially unwanted behavior, vulnerability
  exploitation, security-circumvention, or active vulnerability-scanning feature.
- The Windows executable is already released in the same standalone form that
  will be signed, and its functionality is documented on the download page.
- Installation changes, privacy behavior, opt-out, and uninstallation are
  publicly documented.

## Repository settings

- Set the GitHub repository homepage to the documentation URL.
- Add topics for `education`, `ai`, `provenance`, `academic-integrity`, `cli`,
  and `typescript`.
- Enable secret scanning and push protection.
- Enable private vulnerability reporting so `SECURITY.md` reports can use GitHub
  security advisories.
- Protect `main`: require pull requests, one code-owner approval, dismissal of
  stale approvals, approval after the latest push, resolved conversations, the
  CI/CodeQL/dependency-review checks, block force pushes and deletion, and do
  not grant a routine maintainer bypass.
- Protect `v*` tags from deletion or modification and restrict creation to the
  maintainers.
- Confirm Cassandra and Stephen retain TOTP on GitHub.

## SignPath onboarding

- Install the SignPath GitHub App for this repository.
- Create project `showtail` for the canonical repository.
- Add the predefined GitHub.com trusted build system.
- Create artifact configuration `windows-exe` from
  `.signpath/artifact-configuration.xml`.
- Create `release-signing` with the SignPath Foundation certificate, trusted
  build verification, origin restricted to `main`, and one required approval.
- Create a CI user with submitter-only access; it must not be an approver.
- Add Cassandra and Stephen as human approvers and enable TOTP for both accounts.
- Add repository variable `SIGNPATH_ORGANIZATION_ID` and secret
  `SIGNPATH_API_TOKEN`.
- Change the public code-signing policy status from pending to active, then set
  repository variable `SIGNPATH_ENABLED=true`.

## Reputation gate

Before submitting, add public, independently verifiable evidence that Showtail is
used or trusted: a course or school deployment, public pilot, conference talk,
article, community discussion, or meaningful download/adoption statistics.
Repository activity and the external Awesome Claude Plugins listing may be
included as supplemental evidence, but current stars and release downloads are
not strong enough to rely on alone.
