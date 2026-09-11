# Populated native visual review

From the repository root, run `node desktop/scripts/visual-review.mjs` to open
the production React pages and preload inside an isolated Electron test host.
It uses the approved Electron dependency, platform window appearance and native
application menu. No extra dependency or production entry point is introduced.

The host supplies three unlinked permission requests in Inbox / Requests, one
question linked to a saved conversation, partial history and a conversation that
fails to load. Inbox is a heading rather than a page, and the first request is
selected on launch. Check individual selection, returning from Settings and
the settled view after confirming a sample request; it must not select another
request automatically. The linked conversation starts above a more recent conversation;
answering its sample question clears the badge and returns it to recent order.
Pausing the sample service removes the link and keeps the question in Inbox. The installation is visibly named
**Sample data · this Mac**. Requests use the account response schema; History
uses the existing local transcript shape. They are not recordings of live agents.

Use `node desktop/scripts/visual-review.mjs --edge-cases` for long questions,
exact long button labels, escaped markup, nested scope and an unknown permission
menu. Use `--build-only` to compile without opening a window. Builds go under
`.build/desktop-visual-review`; each launch creates a disposable OS temporary
profile and records its location and PID in that build directory's `profile.json`.
Quit the test window to stop its host. Requests reset on restart.

Use `--chat-pages` for a long saved conversation. It adds 60 earlier records and
one new reply on the second history read. Verify latest-first opening, scroll-up
position across the 15-second refresh, earlier-page insertion without moving the
visible message, and Return to latest. Message authors come from fictional exact
inbound communication IDs, using the same presentation resolver as the app.

This host never loads the production main process, a real account, the gateway
or a provider. Outbound network requests, extra windows and navigation are
denied. Reviews and sample decisions affect in-memory data only. Unsupported
operations, including removal of local history, return an explicit test-only
error. It cannot qualify central delivery, authentication or provider execution.

Check light/dark appearance, Inbox details and reviews, exact radio options,
keyboard focus, conversation selection, partial/unavailable conversations and the
680 × 540 minimum window. Capture populated screens with native app automation.
Keep screenshot galleries under `.build` and label them as sample data.

Conversation finish regression: at 680 × 540, open a linked question. Its review
heading must be visible first, with all choices and the confirmation reachable by
scrolling or keyboard. Transcript refresh and choosing an option must not jump
past that heading. Cancel must restore the pending card. Resize a conversation
that is at the bottom: the latest message must remain visible. Scrolling up must
still preserve the reader's position rather than following the bottom.

Pending-card emphasis: inspect a populated conversation in light/dark and at
680 × 540. The request at the bottom should be visually distinct, with readable
text and a prominent Review button. Long questions must wrap without obscuring
Review or Details. Opening and cancelling the review must preserve the request.
Unlinked Inbox rows retain their existing appearance.
The owner requested a compact translucent light-gray surface and soft shadow
after the flat row faded into the chat. Keep the icon tile and leading border
removed. Check request text and Review alignment in light/dark and compact views,
including expanded details, keyboard focus and opaque transparency fallbacks.
The standalone "Needs your response" heading is removed; the rounded request
surface and Review control identify the pending work. Verify the shared native
secondary-button treatment in light/dark, and that Review still opens the exact
request with no choice selected.

`pnpm --dir desktop test:artifacts` includes request-schema and conversation
rendering regressions. Native focus, scrolling and visual appearance still need
the walkthrough; a static-render test does not prove those interactions.
