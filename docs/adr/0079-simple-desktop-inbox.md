# 0079. A simpler desktop inbox

Status: accepted direction, September 10, 2026. The owner asked to redesign the
app because the previous sidebar and separate views felt too complex.

Navigation superseded by [ADR 0080](0080-conversation-sidebar.md) on September 11.
The page-detail, exact-review and native-presentation rules below still apply.

Replace the permanent sidebar with one main Inbox and a History tab. Open the
Inbox on launch. People, Connect agents and Access remain available through
More. Settings has a visible labelled toolbar button. Secondary screens have
one Back to Inbox action.
Login and guided setup still precede the main app. No business capability is
removed, and no dependency, central API change or release is part of this work.

Inbox combines the existing owner permission and question snapshots into one
chronological list. Preserve each original kind, ID, payload and exact choice.
A preview offers Review; approval still requires a fresh server review and the
existing confirmation. Uncertain submissions remain prominent even when no
pending request is returned. Bounded snapshots cannot imply a complete inbox.
Move limits and technical context into a disclosure, retaining the explicit
missing context inside the review. Empty permission/question groups are omitted.

History opens saved local conversations. Network events, local work and local
permission inspection remain separate, clearly labelled tools under Settings;
owner and agent records are never silently merged or treated as equivalent.
Notification links still open their exact instance and local work view. Every
local work screen identifies its instance, including the single-instance case.

Keep ports, storage locations and instance selection in Settings. A persistent
status strip shows the selected local service and installation, including before
login. Running, Paused, Starting, Pausing and Needs attention reflect the existing
worker snapshot; a running worker with a delivery notice cannot look healthy.
This indicator does not claim central or provider connectivity. It opens Settings,
where Pause/Resume is visible without opening Advanced. Errors remain visible,
with a path to the relevant controls. Agent setup has one primary Connect action per
provider; checks, repair, disconnect and manual setup use a disclosure. Clean
and other destructive actions retain their current review and authorization.

Keep native window controls, system typography, platform appearance, keyboard
navigation and light/dark themes. A compact window has no permanent sidebar.
The underlying owner, gateway, delivery, credentials and no-replay boundaries
remain unchanged.

Test navigation and the combined inbox before implementation. Preserve escaped
remote content, exact choices, unknown-menu refusal, pending and uncertain states,
and existing sign-out/setup gating. Inspect the actual native app in light/dark
and narrow windows, including menu dismissal, secondary navigation and reviews.

The owner's follow-up requested more native presentation, discoverable settings
and visible running state. Use a 52-pixel Mac toolbar with aligned native window
controls, system window material, compact grouped preferences and a notification
switch. Windows/Linux retain their own window decorations. Add Settings to the
native application and tray menus, with Command-comma on Mac and Control-comma
elsewhere. Native menu navigation is an ID-only host request consumed once by
the renderer; it cannot mutate server state or reveal account data while signed
out. Returning from setup settings restores Inbox as the post-login destination.
No new UI toolkit, public IPC command or central route is introduced.

The owner then chose 1Password and Linear as visual references, especially their
typography, spacing and desktop proportions. Refine the existing two-view layout
with neutral surfaces, quieter icons and separators, a consistent 4/8/12/16/24/32
spacing scale and system fonts. Settings uses aligned preference rows rather
than a separate card around each section. Keep its visible toolbar action and
service status. Permission reviews give the requested action a clear heading,
followed by labelled identity, exact action name, expiry and scope. Missing
server context remains visible. Exact radio choices and explicit confirmation
stay below that context. Provider sheets retain wrapped code fields and short
actions. This is presentation work, with no new navigation category, toolkit,
font dependency or business operation.

The next refinement targets detail within pages, keeping this navigation.
Inbox rows use a consistent sender, request and timestamp hierarchy. Reviews
open at their heading with keyboard focus, retain exact choices and wrap scope
and paths. History has readable provider names, an explicit selected row,
independently scrolling transcript and persistent context/pagination controls.
Exact session IDs and technical entries remain available through disclosure.
Do not invent peer names or summaries absent from the session metadata. A
finished provider turn is labelled Turn finished, never a completed action;
partial, interrupted and expired history keep their qualifications. Starting a
different history load clears the previous content; failure offers a retry.

Use populated native screenshots for this review. An offline test host may
render the production page components with visibly labelled fictional account
and conversation data. Keep it outside production entries and disable network,
gateway and provider access. This is visual qualification, not live API evidence.
