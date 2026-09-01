## Code signing policy

The Windows executable in this release is Authenticode signed. Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

Only `showtail-windows-x64.exe` is covered by this signature. See the complete
[Code signing policy](https://tingsters.github.io/Showtail/code-signing-policy/).

Verify it in PowerShell:

```powershell
$signature = Get-AuthenticodeSignature .\showtail-windows-x64.exe
$signature.Status
$signature.SignerCertificate.Subject
```

`Status` must be `Valid`, and the signer subject must contain
`SignPath Foundation`. Compare the file against `SHA256SUMS` from this release.
