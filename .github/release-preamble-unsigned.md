## Windows code signing status

The Windows executable in this release is not Authenticode signed because
Showtail's SignPath Foundation enrollment is still pending. The executable is
built from this tag by the public release workflow and covered by the release's
`SHA256SUMS` file.

Verify the download in PowerShell:

```powershell
(Get-FileHash .\showtail-windows-x64.exe -Algorithm SHA256).Hash.ToLower()
Get-Content .\SHA256SUMS
```

The two SHA-256 values for `showtail-windows-x64.exe` must match. See the
complete [Code signing policy](https://tingsters.github.io/Showtail/code-signing-policy/)
for current enrollment status and scope.
