# Desktop controls, September 14

The owner asked to replace the accordion presentation, improve Back and remove
the hyperlink treatment used for Settings and other app actions.

Use neutral, compact desktop buttons for local actions. Keep the visible Settings
label and native menu shortcut. Back uses one consistent chevron button with a
short label and a destination-specific accessible name.

Technical information, manual instructions and advanced options open a separate
detail sheet instead of expanding the page. A labelled button opens the sheet;
Escape or Done closes it and restores focus to that button. Opening or closing
details never approves, submits or dismisses a parent request. Nested sheets must
return to the still-pending review, preserving the exact selected option.

The conversation/sidebar layout, request order and security decisions stay as
accepted. Native Electron appearance, system typography, light/dark themes and
the existing React implementation remain. No dependency, API or public CLI change
is needed.

Check populated Settings, conversations, request reviews and agent setup, including
long paths and exact options. Verify keyboard focus, nested Escape, the minimum
window size and light/dark presentation. Static rendering alone does not verify
native dialog interaction.

Implemented in the desktop renderer. Devices & agents also opens in a sheet;
its device-change confirmation remains a separate review. The old accordion
markup and selectors were removed rather than retained alongside the new controls.

Validation on macOS with bundled Node 24.19.0:

- All 46 desktop artifact/render tests passed, with typecheck and repository lint.
- `node desktop/scripts/visual-review.mjs --controls-check` passed against the
  production renderer in the isolated Electron visual host. It uses mouse and
  keyboard events for sheet controls, Tab and Escape.
- Checked Settings and Back, device-review cancellation, nested setup instructions,
  exact permission choices, focus restoration, keyboard containment and long paths
  at 680 by 540. Opening or closing details produced no approval submission.
- Inspected populated light/dark captures. The check writes 13 screenshots and
  `checks.json` under `.build/native-controls-review` and exits on completion.

The captures use fictional requests, conversations, devices and setup instructions.
They verify renderer behavior, not central delivery or provider setup. The Mac was
locked during this run; OS title-bar and native-menu interaction were not retested.

Published in [Embassys 0.1.4](https://github.com/embassys/ambassador/releases/tag/desktop-v0.1.4)
after PR 48 and all main release gates passed.
