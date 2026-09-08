# Desktop development packages

For ready-made downloads, use the [preview installation guide](desktop-install.md).
The owner authorized the first GitHub prerelease under
[ADR 0076](adr/0076-desktop-github-preview.md). CI retains verified archives for
seven days; publication still requires successful core and desktop checks for
the exact release source. This does not configure signing or automatic updates.

The desktop build uses the approved Electron Packager, bundled Node 24.19.0 and
the production dependencies in the repository's frozen lockfile. It creates a
fresh hoisted dependency tree outside the checkout's node_modules. Do not use
legacy pnpm deploy here: it resolved newer agent adapters during qualification.

Run these from the repository with the approved pnpm version:

```sh
pnpm --filter @embassys/desktop run build
pnpm --filter @embassys/desktop run package
pnpm --filter @embassys/desktop run verify:portable
pnpm --filter @embassys/desktop run distribute
pnpm --filter @embassys/desktop run verify:distribution
pnpm --filter @embassys/desktop run verify:package
```

Linux's host test needs a display and the normal Electron sandbox configuration;
CI uses its isolated Xvfb display. Never disable the sandbox for qualification.

Output is under `.build/desktop/distribution/`. macOS gets a DMG, Windows a ZIP
and Linux a tar.gz archive. Each has a SHA-256 checksum, exact file inventory and
CycloneDX dependency list. The dependency list records shipped package names,
versions and declared licenses; it is not a license audit or a complete dependency
relationship graph. These commands do not publish anything.

Package inspection rejects external and absolute links. The portability test
temporarily moves `.build/desktop/app`, starts the packaged server with an
isolated PATH, exercises SQLite and MCP, then restores the build directory. Do
not run another build concurrently with that test. Archive verification extracts
the distribution, checks every inventoried entry and starts its real MCP worker.
On Mac it first mounts the DMG read-only, copies its application and unmounts it.

The package attestation is bound to the exact files that packaging verified.
Distribution refuses a package changed after that step. The host also checks
its gateway source digest, app/core/Electron versions, platform, architecture
and private protocol before starting workers. The private handshake requires
the expected Node version. These checks catch corrupt or mismatched builds;
unsigned local checksums do not authenticate a publisher.

## Signing

Default output is explicitly unsigned development output. Request signing only
with configured release infrastructure. The build fails on missing inputs or
failed verification; it never falls back to unsigned output.

Mac previews use an ad hoc signature to seal the complete application after
packaging. This replaces Electron's invalid inherited resource seal; it does not
provide a verified publisher or notarization. Packaging and extracted-DMG checks
both require strict signature integrity. The manifest records `macAdHocSigned`
separately from `applicationCodeSigned`, which means verified publisher signing.
The regular Mac app-specific opening exception can still be required.

- Mac: set `EMBASSYS_DESKTOP_SIGN=1`, `EMBASSYS_MAC_IDENTITY` to the installed
  Developer ID Application identity, and `EMBASSYS_NOTARY_PROFILE` to an existing
  notary keychain profile. No passwords enter these arguments. Packager signs
  the app and bundled binaries and notarizes it. Packaging then checks the
  signature, Gatekeeper assessment and stapled ticket. The running app performs
  these checks before enabling the optional login-startup control.
- Windows: set `EMBASSYS_DESKTOP_SIGN=1` and
  `EMBASSYS_WINDOWS_CERTIFICATE_SHA1` to the installed signing certificate's
  public thumbprint. Packaging verifies the resulting executable, DLL and
  native-module signatures with Authenticode, including the expected signer.
- Linux: signed mode currently refuses. Release archive signing still needs
  an approved key and distribution policy.

The archive manifest distinguishes signed application contents from a signed
archive. Outer DMG/ZIP/tar.gz signing, signed installer qualification, release
channels and automatic updates remain unconfigured. There are no compatible
signed engine releases to offer in a version selector yet. The public CLI npm
release is not an interchangeable desktop engine.

No certificate was available on the development Mac for live signing or login
startup qualification. Windows/Linux CI can verify packages and host lifecycle;
it does not prove native desktop interactions, notifications or provider behavior.

See [ADR 0066](adr/0066-desktop-completion.md) and the
[desktop implementation plan](desktop-app-plan.md) for the remaining inputs.


## Diagnostic policy in a build

The default development build records bounded request and response bodies after
credential redaction. Set `EMBASSYS_DESKTOP_DIAGNOSTICS=production` for metadata-only
logging. Any other value fails the build. The verified manifest records this
choice; it is not a runtime agent option or a CLI flag. Both policies use at most
1 GiB per app instance and expire log segments after seven days while the instance
runs or when its diagnostics are next opened. The app can clear these logs without
stopping its server. Export previews are limited to 32 MiB per selection.

This setting does not make an unsigned development package a production release.
