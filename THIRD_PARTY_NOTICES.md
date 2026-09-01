# Third-party notices

Showtail is licensed under the Apache License 2.0. Its standalone executables
also contain the following Open Source components.

## Runtime dependencies

| Component | Version | License | Source |
| --- | --- | --- | --- |
| commander | 14.0.3 | MIT | https://github.com/tj/commander.js |
| turbo-stream | 2.4.1 | ISC | https://github.com/jacob-ebey/turbo-stream |

The exact versions used for a release are also recorded in `bun.lock` and the
release SBOM.

## Bun runtime

Showtail standalone executables are produced with Bun 1.4.0, pinned in
`.bun-version`, and contain a copy of the Bun runtime.

Bun itself is MIT licensed. Bun statically links JavaScriptCore and WebKit code
licensed under LGPL-2, plus other Open Source libraries under permissive and
copyleft licenses. Bun's authoritative license and linked-library inventory for
the pinned release is available at:

https://github.com/oven-sh/bun/blob/bun-v1.4.0/LICENSE.md

The corresponding Bun and patched WebKit source code is available at:

- https://github.com/oven-sh/bun/tree/bun-v1.4.0
- https://github.com/oven-sh/webkit

Showtail's complete source and build scripts are available at:

https://github.com/Tingsters/Showtail

To rebuild Showtail with a modified Bun or JavaScriptCore/WebKit runtime, build
the desired Bun runtime using Bun's documented `git clone
https://github.com/oven-sh/WebKit vendor/WebKit`, `bun sync-webkit-source`, and
`bun run build:local` process, then run Showtail's release build with that Bun
executable. This provides the source and relinking path required for the
LGPL-covered runtime components.

## VS Code extension

The packaged Showtail extension contains Showtail code under Apache-2.0 and uses
the VS Code extension API supplied by the host editor. Its build-only tooling is
not bundled into the VSIX.

This notice is informational and does not change the license terms of any
component. Refer to each linked upstream project for its complete license text
and notices.
