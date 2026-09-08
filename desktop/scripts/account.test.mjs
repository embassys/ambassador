import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = await mkdtemp(join(tmpdir(), "embassys-account-ui-test-"));
await build({
  stdin: {
    contents: `import {createElement} from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {Account, AccountData} from './src/account.tsx'; import {Navigation} from './src/navigation.tsx'; import {Onboarding} from './src/onboarding.tsx'; export {onboardingKey} from './src/onboarding-state.ts'; export const onboarding = owner => renderToStaticMarkup(createElement(Onboarding,{owner,call:async()=>{},changed:async()=>{},complete:()=>{},settings:()=>{}})); export const nav = page => renderToStaticMarkup(createElement(Navigation,{page,select:()=>{}})); export const view = data => renderToStaticMarkup(createElement(AccountData, {data})); export const account = (snapshot, section) => renderToStaticMarkup(createElement(Account, {snapshot,section,call:async()=>{},changed:async()=>{}}));`,
    resolveDir: process.cwd(),
    sourcefile: "account-test-entry.tsx",
  },
  outfile: join(root, "account.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  jsx: "automatic",
});
const { view, account, nav, onboarding, onboardingKey } = await import(
  pathToFileURL(join(root, "account.mjs")).href
);
test.after(() => rm(root, { recursive: true, force: true }));

test("signed-out onboarding starts with login or registration, without the dashboard", () => {
  const html = onboarding({ status: "signed_out", context: "one" });
  assert.match(html, />Log in</);
  assert.match(html, />Register</);
  assert.doesNotMatch(html, /Main navigation|Permissions|<form|MCP|Selected instance|Account logs/);
  const signingOut = onboarding({
    status: "signed_out",
    context: "next",
    issue: "signout_unconfirmed",
  });
  assert.match(signingOut, />Log in</);
  assert.match(signingOut, />Register</);
  assert.match(signingOut, /couldn.*confirm sign-out/);
  assert.doesNotMatch(signingOut, /<form/);
  const loading = onboarding({ status: "loading", context: "one" });
  assert.match(loading, /Opening Embassys/);
  assert.doesNotMatch(loading, />Register</);
  const code = onboarding({ status: "code_sent", context: "one", email: "owner@fixture.test" });
  assert.match(code, /one-time-code/);
});

test("setup completion belongs to a signed-in account and selected installation", () => {
  const owner = { status: "signed_in", context: "one", email: "owner@fixture.test" };
  assert.ok(onboardingKey(owner, "instance-one"));
  assert.equal(onboardingKey({ ...owner, status: "signed_out" }, "instance-one"), undefined);
  assert.equal(onboardingKey({ ...owner, status: "reauth_required" }, "instance-one"), undefined);
  assert.notEqual(onboardingKey(owner, "instance-one"), onboardingKey(owner, "instance-two"));
  assert.notEqual(
    onboardingKey(owner, "instance-one"),
    onboardingKey({ ...owner, email: "someone@fixture.test" }, "instance-one"),
  );
  assert.equal(
    onboardingKey(owner, "instance-one"),
    onboardingKey({ ...owner, context: "refreshed" }, "instance-one"),
  );
});

test("navigation has four sections and keeps device settings under Account", () => {
  const html = nav("diagnostics");
  assert.equal((html.match(/<button/gu) || []).length, 4);
  assert.match(html, /Requests/);
  assert.match(html, /Permissions/);
  assert.match(html, /Messages/);
  assert.match(html, /aria-current="page"[^>]*>.*Account/);
  assert.doesNotMatch(html, /Registration|Diagnostics|Workspace/);
});

test("account requests escape agent text, preserve choice labels and offer no decision buttons", () => {
  const html = view({
    kind: "requests",
    total: 1,
    permission_requests: [],
    input_requests: [
      {
        id: "question-1",
        prompt: '<img src=x onerror="steal()">',
        input_type: "buttons",
        options: [{ label: "Allow this one only", value: "provider-id" }],
        created_at: "2026-09-07T10:00:00Z",
        action_type: "get_phone_number",
      },
    ],
  });
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img|<button|onClick|onclick/);
  assert.match(html, /Allow this one only/);
  assert.match(html, /may not include every pending request/);
});
test("permission direction and central message limitations stay explicit", () => {
  const html = view({
    kind: "permissions",
    direction: "received",
    permissions: [
      {
        id: "permission-1",
        action_type: "read_calendar_permission",
        status: "revoked",
        direction: "granted_to_me",
        grantor_email: "peer@fixture.test",
        decided_at: null,
        expires_at: null,
        uses_remaining: 0,
        scope: null,
      },
    ],
  });
  assert.match(html, /From peer@fixture.test/);
  assert.match(html, /revoked/);
  assert.match(html, /Uses remaining<\/dt><dd>0/);
  assert.match(
    view({ kind: "communications", communications: [] }),
    /does not confirm that an agent completed/,
  );
});
test("owner sign-in form is separate from local agent registration and sign-out", () => {
  const opening = account({ context: "context", status: "loading" });
  assert.match(opening, /Opening your account/);
  assert.doesNotMatch(opening, /<form|service is unavailable/);
  const initial = account({ context: "context", status: "signed_out" });
  assert.match(initial, /Send sign-in code/);
  assert.match(
    account({ context: "context", status: "signed_in" }),
    /Signing out keeps local servers running/,
  );
  assert.doesNotMatch(initial, /type="password"|access_token|refresh_token/);
  const waiting = account({
    context: "context",
    status: "code_sent",
    email: "owner@fixture.test",
    resendAt: Date.now() + 69000,
  });
  assert.match(waiting, /autocomplete="one-time-code"/iu);
  assert.match(waiting, /Resend in 60s/);
  assert.match(waiting, /If .*owner@fixture.test.* has an Embassys agent/);
});

test("primary account views have one purpose and redirect sign-in to Account", () => {
  const signedOut = account({ context: "context", status: "signed_out" }, "requests");
  assert.match(signedOut, /Sign in/);
  assert.doesNotMatch(signedOut, /<form|Account view|name="account-tab"/);
  const signedIn = account(
    { context: "context", status: "signed_in", email: "owner@fixture.test" },
    "permissions",
  );
  assert.match(signedIn, /Shared by you|Shared with you/);
  assert.doesNotMatch(signedIn, /Sign out|name="account-tab"/);
});
