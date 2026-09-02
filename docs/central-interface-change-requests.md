# Central follow-ups

Status: nonblocking server improvements as of 2026-09-02

These items are useful changes to the current REST service. They are not a
second API contract and the gateway must not emulate them with compatibility
branches.

## Needed for complete route coverage

### Fix permission listing

`GET /api/get_my_permissions` declares `grantor_email` and `grantee_email` but
constructs username-named fields. The protected I05 call confirmed a deployed
server error. Make the implementation and model agree and add a route test.

## Useful development hardening

- Restore a finite verification-code expiry and compare timezone-compatible
  timestamps.
- Make registration fail when the verification email cannot be sent, or
  return a clear delivery status that does not imply success.
- Expose a nonsecret build revision in `/health` for deploy/source matching.
- Stop including raw exception text in `500` responses and server logs that
  may contain user data.
- Add database-backed or shared rate limiting if the service runs more than
  one process.
- Fix the expiring-permission comparison in `call_action`.
- Remove or repair the duplicate grant/deny endpoints so one permission
  decision path remains.
- Either wire invitation creation into first contact or remove the guide's
  automatic-invitation claim.

## Later reliability improvements

The current consuming poll can lose a delivered message when a gateway crashes
before acknowledgement. A future server change could add delivered-message
retrieval or lease-based redelivery and make acknowledgement idempotent.

That change should extend the existing unversioned REST surface during
development unless the server actually needs a separate compatibility period.
When implemented, update server tests, source inventory, gateway tests, and
gateway behavior together. Do not keep a client-side probe or fallback.

The same process applies to token refresh, revocation, or deliberate
credential recovery. They are worthwhile features, not prerequisites for the
current integration.

## Explicitly not requested

- a central MCP implementation for the gateway;
- `/api/v2` solely for version labeling;
- delivery activation;
- a free-text conversation and reply protocol;
- a server migration from an installed gateway client; or
- support for old bearer-only gateway credentials.
