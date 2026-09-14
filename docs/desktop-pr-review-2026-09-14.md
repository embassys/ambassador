# Desktop and central adoption review, September 14

[PR 45](https://github.com/embassys/ambassador/pull/45) combines the pending
People and ARM64 desktop changes with ADR 0082's current central contracts and
ADR 0083's one-code setup. It does not change server code, dependency versions,
public CLI flags or release versions.

The review covered owner/agent credential separation, execution transfer and
archive-key preservation, exact action/result contracts, durable submission
recovery, custody before acknowledgement, owner pagination and event cursors,
provider setup, People invitation semantics and platform build selection.

Two additional regressions were fixed during review:

- Onboarding now reads the current owner roster before reusing a saved execution
  credential. A transfer or changed execution epoch requires setup again, even
  while the old token remains unexpired. Moving another device remains explicit.
- Notification registration and removal run in order. A delayed registration's
  cleanup cannot remove a newer enabled registration. The regression reproduced
  the backend registration disappearing while the UI still said registered.

Both regressions failed against the previous code and passed after the fixes.
The live one-code onboarding and interrupted creation tests are recorded in
[the onboarding qualification](one-code-onboarding-2026-09-14.md). Earlier
protected central tests and independent fixtures remain in the
[adoption record](central-adoption-2026-09-14.md). PR checks qualify the committed
candidate; no test result authorizes publication.

API issue 18's new owner communication history remains a separate adoption task.
Native push credentials/signing, physical Pi testing and the remaining real
provider/platform matrix retain their existing limits. No additional blocking
code finding remained after the review fixes and local checks. Cross-platform
CI is required before merge.
