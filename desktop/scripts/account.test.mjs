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
    contents: `import {createElement} from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {Account, AccountData, OwnerDecisionForm, requestItems} from './src/account.tsx'; import {Navigation, AppMenu, SettingsButton, ServiceStatus, serviceStatus, WorkspaceWelcome} from './src/navigation.tsx'; import {applicationMenu} from './src/application-menu.ts'; export {applicationMenu, serviceStatus}; export const welcome = () => renderToStaticMarkup(createElement(WorkspaceWelcome,{people:()=>{},agents:()=>{}})); export const settingsButton = () => renderToStaticMarkup(createElement(SettingsButton,{open:()=>{}})); export const status = runtime => renderToStaticMarkup(createElement(ServiceStatus,{runtime,name:'Test installation',open:()=>{}})); import {Onboarding} from './src/onboarding.tsx'; import {PeopleIntroduction, ContactImportGuide, PeopleList} from './src/people.tsx'; export const peopleList = contacts => renderToStaticMarkup(createElement(PeopleList,{contacts,busy:false,open:()=>{},copy:()=>{}})); export const peopleIntro = () => renderToStaticMarkup(createElement(PeopleIntroduction)); export const importGuide = () => renderToStaticMarkup(createElement(ContactImportGuide,{chooseFile:()=>{}})); export {onboardingKey} from './src/onboarding-state.ts'; export {prepareOnboardingAgent} from './src/onboarding-setup.ts'; export {requestItems}; export const menu = () => renderToStaticMarkup(createElement(AppMenu,{select:()=>{}})); export const onboarding = owner => renderToStaticMarkup(createElement(Onboarding,{owner,call:async()=>{},changed:async()=>{},complete:()=>{},settings:()=>{}})); export const nav = (page, requests, selectedRequest) => renderToStaticMarkup(createElement(Navigation,{page,requests,selectedRequest,selectRequest:()=>{},select:()=>{},sessions:[],selected:"",selectSession:()=>{}})); export {inboxEntries, selectInboxRequest} from './src/inbox-navigation.ts'; export const decision = review => renderToStaticMarkup(createElement(OwnerDecisionForm,{review,busy:false,submit:()=>{},cancel:()=>{}})); export const view = (data, focusedRequest = false) => renderToStaticMarkup(createElement(AccountData, {data, focusedRequest})); export const account = (snapshot, section) => renderToStaticMarkup(createElement(Account, {snapshot,section,call:async()=>{},changed:async()=>{}}));`,
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
const {
  peopleList,
  peopleIntro,
  importGuide,
  welcome,
  view,
  decision,
  account,
  nav,
  menu,
  requestItems,
  onboarding,
  onboardingKey,
  prepareOnboardingAgent,
  settingsButton,
  status,
  serviceStatus,
  applicationMenu,
  inboxEntries,
  selectInboxRequest,
} = await import(pathToFileURL(join(root, "account.mjs")).href);
test.after(() => rm(root, { recursive: true, force: true }));

test("signed-out onboarding starts with login or registration, without the dashboard", () => {
  const html = onboarding({ status: "signed_out", context: "one" });
  assert.match(html, />Log in</);
  assert.match(html, />Register</);
  assert.match(html, />Welcome to Embassys</);
  assert.match(html, /<header[^>]*>[\s\S]*>Settings<\/span>[\s\S]*<\/header>/);
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

test("Inbox and Conversations are sidebar headings, without an aggregate Inbox page", () => {
  const html = nav("attention");
  assert.match(html, />Inbox</);
  assert.match(html, /Conversations/);
  assert.match(html, /<h2>Inbox<\/h2>/);
  assert.match(html, /<h2>Conversations<\/h2>/);
  assert.doesNotMatch(html, /inbox-nav-row|aria-current="page"/);
  assert.doesNotMatch(html, />History</);
  assert.match(nav("people"), /aria-current="page"[^>]*>[\s\S]*People/);
  assert.ok(html.indexOf(">People<") < html.indexOf(">Inbox<"));
  const tools = menu();
  for (const label of ["Connect agents", "Access"]) assert.match(tools, new RegExp(label));
  assert.match(tools, /popover="auto"/);
  assert.doesNotMatch(tools, />Settings<|>People</);
  assert.match(settingsButton(), />Settings</);
  assert.doesNotMatch(tools, /Clean|port|MCP|instance/i);
});

test("the inbox combines questions and permissions without changing their IDs or inputs", () => {
  const permission = {
    id: "shared-id",
    action_type: "get_phone_number",
    created_at: "2026-09-10T08:00:00Z",
  };
  const question = {
    id: "shared-id",
    action_type: "get_phone_number",
    prompt: "What number?",
    created_at: "2026-09-10T09:00:00Z",
  };
  const data = { kind: "requests", permission_requests: [permission], input_requests: [question] };
  assert.deepEqual(requestItems(data), [
    { kind: "input", item: question },
    { kind: "permission", item: permission },
  ]);
  assert.equal(data.permission_requests[0], permission);
  assert.equal(data.input_requests[0], question);
  assert.deepEqual(requestItems({ ...data, permission_requests: [], input_requests: [] }), []);
  const html = view({ ...data, unconfirmed: [] });
  assert.doesNotMatch(html, /No permission requests|No questions in this snapshot/);
  assert.match(html, /What number/);
});

test("a quiet inbox does not hide uncertain submissions", () => {
  const empty = { kind: "requests", permission_requests: [], input_requests: [] };
  assert.match(view(empty), /No requests to review/);
  const uncertain = view({
    ...empty,
    unconfirmed: [{ id: "unconfirmed", kind: "permission", action_type: "get_phone_number" }],
  });
  assert.doesNotMatch(uncertain, /No requests to review/);
  assert.match(uncertain, /may have been accepted/);
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
  assert.doesNotMatch(html, /<img|onClick|onclick|type="submit"/);
  const buttonLabels = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((match) =>
    match[1].replace(/<[^>]+>/g, ""),
  );
  assert.deepEqual(buttonLabels, ["Details", "Done", "About this inbox", "Done"]);
  assert.match(html, /Allow this one only/);
  assert.match(html, /Large inboxes have additional pages/);
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
  assert.match(waiting, /only code you need for setup/);
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

test("owner review exposes exact choices and escapes remote content", () => {
  const review = {
    kind: "review",
    review_id: "review-1",
    expires_at: "2099-01-01T00:00:00Z",
    target: {
      kind: "input",
      item: {
        id: "input-1",
        action_type: "get_phone_number",
        prompt: "<script>steal()</script>",
        input_type: "buttons",
        options: [{ label: "Only this invocation", value: "provider:allow-once" }],
      },
    },
  };
  const html = decision(review);
  assert.match(html, /&lt;script/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /Only this invocation/);
  assert.match(html, /Cancel/);
  assert.match(html, /Confirm answer/);
  const unknown = decision({
    ...review,
    target: {
      kind: "permission",
      item: {
        id: "request-1",
        action_type: "get_phone_number",
        decision_options: "future-menu",
        expires_at: null,
      },
    },
  });
  assert.doesNotMatch(unknown, /value="accept"|value="allow_always"/);
});

test("a permission review separates the request, identity and scope without hiding missing context", () => {
  const html = decision({
    review_id: "review-current",
    target: {
      kind: "permission",
      item: {
        id: "request-current",
        action_type: "read_calendar_permission",
        action_description: "Read your calendar availability",
        requester_name: "Alex Morgan",
        requester_email: "alex@fixture.test",
        decision_options: "once_always",
        expires_at: null,
        scope: { calendar_id: "primary", note: "<script>untrusted</script>" },
      },
    },
  });
  assert.match(html, /<h2[^>]*>Read your calendar availability<\/h2>/);
  assert.match(html, /<dt>From<\/dt>/);
  assert.match(html, /Alex Morgan/);
  assert.match(html, /alex@fixture.test/);
  assert.match(html, /read_calendar_permission/);
  assert.match(html, /No reason supplied/);
  assert.match(html, /No expiry provided/);
  assert.match(html, /Permission scope/);
  assert.match(html, /&lt;script&gt;untrusted/);
  assert.doesNotMatch(html, /<script|checked=""/);
  for (const value of ["deny", "allow_once", "allow_always"])
    assert.match(html, new RegExp(`value="${value}"`));
  assert.match(html, /<button[^>]*disabled=""[^>]*>Confirm decision/);
});

test("service status reports actual local states without claiming remote connectivity", () => {
  for (const [state, label] of [
    ["running", "Running"],
    ["stopped", "Paused"],
    ["starting", "Starting…"],
    ["stopping", "Pausing…"],
    ["error", "Needs attention"],
  ]) {
    assert.equal(serviceStatus({ id: "one", state }).label, label);
    const html = status({ id: "one", state });
    assert.match(html, new RegExp(label));
    assert.match(html, /Test installation/);
    assert.match(html, /Local service/);
    assert.doesNotMatch(html, /Connected|Online|all systems/i);
  }
  assert.equal(serviceStatus(undefined).label, "Checking…");
  assert.equal(
    serviceStatus({ id: "one", state: "running", notice: "Delivery paused" }).label,
    "Needs attention",
  );
  assert.equal(
    serviceStatus({ id: "one", state: "running", error: "Unavailable" }).label,
    "Needs attention",
  );
});

test("native Settings uses the standard shortcut and only opens the settings view", () => {
  let opened = 0;
  for (const platform of ["darwin", "win32", "linux"]) {
    const items = applicationMenu(platform, () => opened++);
    const first = items[0];
    const settings = first.submenu.find((item) => item.id === "settings");
    assert.equal(settings.label, "Settings…");
    assert.equal(settings.accelerator, "CommandOrControl+,");
    settings.click();
    assert.ok(items.some((item) => item.role === "editMenu"));
    assert.ok(items.some((item) => item.role === "windowMenu"));
    if (platform === "darwin") assert.equal(first.label, "Embassys");
    else assert.equal(first.label, "File");
  }
  assert.equal(opened, 3);
});

test("sidebar requests preserve kind-qualified selection and unconfirmed submissions", () => {
  const data = {
    kind: "requests",
    total: 2,
    permission_requests: [
      {
        id: "same",
        requester_name: "Alex <script>",
        action_type: "get_phone_number",
        created_at: "2026-09-11T08:00:00Z",
      },
    ],
    input_requests: [
      {
        id: "same",
        prompt: "What time?",
        action_type: "calendar",
        created_at: "2026-09-11T09:00:00Z",
      },
    ],
    unconfirmed: [
      { id: "same", kind: "permission", action_type: "get_phone_number" },
      { id: "other", kind: "input", action_type: "calendar" },
    ],
    unconfirmedMore: true,
  };
  const entries = inboxEntries(data);
  assert.equal(entries.length, 3);
  assert.equal(entries.filter((e) => e.key === "permission:same").length, 1);
  assert.equal(entries.find((e) => e.key === "permission:same").uncertain, true);
  const chosen = selectInboxRequest(data, "input:same");
  assert.deepEqual(chosen.input_requests, data.input_requests);
  assert.equal(chosen.permission_requests.length, 0);
  assert.equal(chosen.unconfirmed.length, 0);
  assert.equal(chosen.unconfirmedMore, false);
  assert.equal(chosen.total, 1);
  assert.equal(selectInboxRequest(data, "missing").total, 0);
  assert.equal(selectInboxRequest(data, "input:other").unconfirmed.length, 1);
  assert.equal(selectInboxRequest(data, ""), data);
  assert.equal(data.total, 2);
  const html = nav("attention", data, "input:same");
  assert.match(html, /aria-label="Inbox requests"/);
  assert.match(html, /Alex &lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /aria-pressed="true"[^>]*>[\s\S]*What time/);
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
  assert.ok(html.indexOf("What time?") < html.indexOf(">Conversations<"));
  assert.match(html, /Awaiting confirmation/);
});

test("focused requests keep uncertainty and settled-state messages without an Inbox overview", () => {
  const empty = { kind: "requests", total: 0, permission_requests: [], input_requests: [] };
  const settled = view(empty, true);
  assert.match(settled, /This request is no longer pending/);
  assert.doesNotMatch(settled, /About this inbox|No requests to review/);
  const uncertain = view(
    { ...empty, unconfirmed: [{ kind: "input", id: "one", action_type: "calendar" }] },
    true,
  );
  assert.match(uncertain, /may have been accepted/);
  assert.doesNotMatch(uncertain, /About this inbox|no longer pending/);
});

test("the empty workspace explains the next step after setup", () => {
  const html = welcome();
  assert.match(html, /Start with someone you know/);
  assert.match(html, />Add people</);
  assert.match(html, />Connect agents</);
  assert.match(html, /email|contacts/);
  assert.doesNotMatch(html, /invitation sent|automatically|already connected/i);
});

test("People distinguishes local saving from invitations and explains contact-file import", () => {
  const html = peopleIntro();
  assert.match(html, /Saving a person doesn’t invite them or grant access/);
  assert.doesNotMatch(html, /Invitations aren.*available yet/);
  const guide = importGuide();
  assert.match(guide, /vCard/);
  assert.match(guide, /\.vcf/);
  assert.match(guide, />Choose file/);
  assert.match(guide, /choose who to save/);
  assert.match(guide, /Nothing is sent/);
  assert.doesNotMatch(guide, /mailto:|href=|checked=/);
});

test("People uses one list with direct copy actions and escaped contact names", () => {
  const html = peopleList([
    { name: "Alex <script>", email: "alex@fixture.test" },
    { name: "Sam Rivera", email: "sam@fixture.test" },
  ]);
  assert.match(html, /aria-label="Saved people"/);
  assert.match(html, /Alex &lt;script&gt;/);
  assert.match(html, /alex@fixture.test/);
  assert.equal((html.match(/>Copy email</g) || []).length, 2);
  assert.doesNotMatch(html, /<script>|<aside|with-detail|aria-pressed/);
});

test("empty sidebar hints are short and distinct from navigation headings", () => {
  const html = nav("attention");
  assert.match(html, /class="sidebar-empty"[^>]*>No conversations yet</);
  assert.doesNotMatch(html, /Conversations appear here when/);
});

test("onboarding installs a first agent with no second email or premature provider connection", async () => {
  const calls = [];
  const owner = {
    status: "signed_in",
    context: "ctx",
    email: "me@fixture.test",
    account: { device_id: "here" },
  };
  const review = {
    kind: "device_review",
    review_id: "review",
    device: { id: "here", is_current: true },
    agent: { id: "agent", executor_device_id: null },
  };
  const call = async (command) => {
    calls.push(command);
    if (command.type === "owner_profile")
      return {
        snapshot: owner,
        data: {
          kind: "profile",
          profile: {
            agents: [
              {
                id: "agent",
                email: owner.email,
                email_verified: true,
                executor_device_id: review.agent.executor_device_id,
                executor_epoch: 2,
              },
            ],
          },
        },
      };
    if (command.type === "owner_create_agent")
      return { snapshot: owner, data: { kind: "agent_setup", agent: { id: "agent" } } };
    if (command.type === "owner_device_review") return { snapshot: owner, data: review };
    if (command.type === "owner_device_submit")
      return { data: { kind: "device_result", confirmed: true, local_ready: true } };
    if (command.type === "enrollment_status")
      return {
        phase: "registered",
        agentId: "agent",
        email: owner.email,
        credentialStatus: "active",
        needsExecutor: true,
      };
    throw new Error("Unexpected command");
  };
  const result = await prepareOnboardingAgent(owner, { phase: "new" }, "instance", call);
  assert.equal(result.registration.needsExecutor, true);
  assert.deepEqual(
    calls.map((c) => c.type),
    ["owner_create_agent", "owner_device_review", "owner_device_submit", "enrollment_status"],
  );
  assert.equal(calls[2].instanceId, "instance");
  calls.length = 0;
  review.agent.executor_device_id = "elsewhere";
  const move = await prepareOnboardingAgent(owner, { phase: "new" }, "instance", call);
  assert.equal(move.review.review_id, "review");
  assert.equal(
    calls.some((c) => c.type === "owner_device_submit"),
    false,
  );
  calls.length = 0;
  await prepareOnboardingAgent(owner, { phase: "new" }, "instance", call, move.review);
  assert.deepEqual(
    calls.map((c) => c.type),
    ["owner_device_submit", "enrollment_status"],
  );
  calls.length = 0;
  await assert.rejects(
    prepareOnboardingAgent(
      owner,
      { phase: "registered", email: "other@fixture.test" },
      "instance",
      call,
    ),
    /different account/,
  );
  assert.equal(calls.length, 0);
  review.agent.executor_device_id = null;
  await prepareOnboardingAgent(owner, result.registration, "instance", call);
  assert.deepEqual(
    calls.map((c) => c.type),
    ["owner_profile"],
  );
  calls.length = 0;
  await prepareOnboardingAgent(
    owner,
    { ...result.registration, agentId: "previous-agent" },
    "instance",
    call,
  );
  assert.equal(
    calls.some((c) => c.type === "owner_device_submit"),
    true,
  );
  calls.length = 0;
  review.agent.executor_device_id = "elsewhere";
  const moved = await prepareOnboardingAgent(owner, result.registration, "instance", call);
  assert.equal(moved.review.review_id, "review");
  assert.equal(
    calls.some((c) => c.type === "owner_device_submit"),
    false,
  );
  calls.length = 0;
  review.agent.executor_device_id = "here";
  await prepareOnboardingAgent(
    owner,
    { ...result.registration, executionDeviceId: "here", executorEpoch: 1 },
    "instance",
    call,
  );
  assert.equal(
    calls.some((c) => c.type === "owner_device_submit"),
    true,
  );
  calls.length = 0;
  await prepareOnboardingAgent(
    owner,
    { ...result.registration, executionDeviceId: "here", executorEpoch: 2 },
    "instance",
    call,
  );
  assert.deepEqual(
    calls.map((c) => c.type),
    ["owner_profile"],
  );
  await assert.rejects(
    prepareOnboardingAgent(
      owner,
      { phase: "new" },
      "instance",
      async () => ({ data: { kind: "device_result", confirmed: true, local_ready: false } }),
      move.review,
    ),
    /setup did not finish/,
  );
  await assert.rejects(
    prepareOnboardingAgent(
      owner,
      { phase: "new" },
      "instance",
      async () => ({ issue: "review_expired" }),
      move.review,
    ),
    /Review.*again/,
  );
  await assert.rejects(
    prepareOnboardingAgent(owner, { phase: "new" }, "instance", async (command) => {
      const reply = await call(command);
      return command.type === "enrollment_status" ? { ...reply, agentId: "previous-agent" } : reply;
    }),
    /could not confirm/,
  );
});
