# 0076 Downloadable desktop preview

Status: accepted

Date: 2026-09-08

The owner requested a GitHub release that people can download and run after
reviewing the unsigned development build and remaining distribution work. This
authorizes the first desktop prerelease, `desktop-v0.1.0-preview.1`, using the
existing app version 0.1.0 and bundled engine. It amends the earlier exclusion of
desktop publication for this preview only. It does not authorize central API
changes, another npm release, signing credentials, automatic updates or a
production support claim.

Retain the existing CI-built DMG, ZIP and tar.gz files only after the portable
runtime, extracted archive, packaged host and CLI/app handoff checks succeed.
Use the already approved upload-artifact action with seven-day retention and
without recompressing the archives. Keep the workflow read-only. Publication is
an explicit owner-authorized operation after all core, fixture, package and
desktop checks pass for the release source commit. Do not publish partial builds
or replace assets of an already published preview.

Create a separate GitHub prerelease, leave the CLI's latest release unchanged,
and attach each archive with its checksum, file inventory and dependency list.
Record the source commit and successful CI runs in the release notes. Download
the uploaded files and verify their hashes before reporting completion.

The Mac Apple silicon app has native qualification. Windows x64 and Linux x64
have CI runtime and lifecycle evidence only and remain experimental downloads.
Do not offer an Intel Mac download unless its separate build and checks pass.
Unsigned Mac and Windows downloads can require an OS exception or be blocked by
device policy. Mac login startup stays unavailable. Linux requires its normal
Electron sandbox setup; never recommend disabling the sandbox or system-wide
security controls to make the app run.

The preview retains the approved development logging policy with credential
redaction, a seven-day expiry and a 1 GiB per-instance limit. The release page
must disclose body logging, existing API recovery gaps, two-code signup and
client-specific qualification limits. The app still needs an installed and
authenticated agent to execute incoming work.

Signed production distribution, updates, native Linux/Windows qualification and
future preview releases require their own work and authorization.
