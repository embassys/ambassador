import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { edgeRequests, requests } from "./visual/data.mjs";

const root = await mkdtemp(join(tmpdir(), "embassys-history-ui-"));
await build({
  stdin: {
    contents: `import {createElement} from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {ConversationList,ConversationContent} from './src/history.tsx'; import {requestsSchema} from "../src/desktop/owner-protocol.ts"; import {Disclosure, StructuredData} from './src/details.tsx'; export const detail = value => renderToStaticMarkup(createElement(Disclosure,{title:'Request details'},createElement(StructuredData,{value}))); export const validateRequests = value => requestsSchema.parse(value); export const list = (sessions,selected='',attention) => renderToStaticMarkup(createElement(ConversationList,{sessions,selected,attention,select:()=>{}})); export const content = (history,busy=false) => renderToStaticMarkup(createElement(ConversationContent,{history,busy,sessionId:'exact-session',reload:()=>{},next:()=>{},remove:()=>{}}));`,
    resolveDir: fileURLToPath(new URL("../", import.meta.url)),
    sourcefile: "history-test.tsx",
  },
  outfile: join(root, "history.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  banner: {
    js: `import {createRequire} from 'node:module';const require=createRequire(import.meta.url);`,
  },
});
const { list, content, validateRequests, detail } = await import(
  pathToFileURL(join(root, "history.mjs")).href
);
test.after(() => rm(root, { recursive: true, force: true }));

test("conversation rows use provider display names, exact identity and selected state", () => {
  const html = list(
    [
      {
        session_id: "exact-session",
        agent_kind: "claude_code",
        status: "active",
        last_used_at_ms: 1789032600000,
      },
    ],
    "exact-session",
  );
  assert.match(html, /Claude Code/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /exact-session/);
  assert.doesNotMatch(html, />claude_code</);
  assert.match(
    list([
      {
        session_id: "<script>id</script>",
        agent_kind: "future_provider",
        status: "retired",
        last_used_at_ms: 0,
      },
    ]),
    /&lt;script&gt;/,
  );
});
test("saved turns stay distinct from completed actions and preserve escaped transcript content", () => {
  const page = {
    source: "archive",
    warnings: ["Only a partial conversation was saved."],
    hasMore: true,
    nextCursor: 5,
    items: [
      {
        id: "turn",
        kind: "turn",
        actionType: "get_free_busy_permission",
        status: "complete",
        createdAt: 1789032600000,
      },
      {
        id: "user",
        kind: "entry",
        role: "user",
        text: '{"title":"<img src=x>"}',
        createdAt: 1789032600000,
      },
      {
        id: "agent",
        kind: "entry",
        role: "agent",
        text: "Alex is free after 4pm.\nNo event has been created.",
        createdAt: 1789032601000,
      },
      {
        id: "tool",
        kind: "entry",
        role: "tool",
        text: '{"call_id":"keep-exact"}',
        createdAt: 1789032602000,
      },
    ],
  };
  const html = content(page);
  assert.match(html, /finished agent turn does not confirm/);
  assert.doesNotMatch(html, /Action completed|<img/);
  assert.match(html, /&lt;img/);
  assert.match(html, /No event has been created/);
  assert.match(html, /Only a partial conversation was saved/);
  assert.match(html, /Embassys message/);
  assert.match(html, /Tool activity/);
  assert.match(html, /keep-exact/);
  assert.match(html, /Conversation details/);
  assert.match(html, /exact-session/);
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Earlier messages/);
  assert.match(content(page, true), /Alex is free/);
  assert.match(content(undefined, true), /Loading conversation/);
});
test("provider previews and unfinished archives retain their qualifications", () => {
  assert.match(
    content({
      source: "provider",
      lines: ["<script>text</script>"],
      warnings: ["Partial provider preview"],
      hasMore: false,
      nextCursor: 0,
    }),
    /Partial provider preview/,
  );
  assert.doesNotMatch(
    content({
      source: "provider",
      lines: ["<script>text</script>"],
      warnings: [],
      hasMore: false,
      nextCursor: 0,
    }),
    /<script/,
  );
  const html = content({
    source: "archive",
    warnings: [],
    hasMore: false,
    nextCursor: 0,
    items: [
      {
        id: "turn",
        kind: "turn",
        actionType: "get_phone_number",
        status: "recording",
        createdAt: 0,
      },
    ],
  });
  assert.match(html, /In progress or interrupted/);
  assert.doesNotMatch(html, /Turn finished/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Earlier messages/);
});

test("visual requests follow the deployed account shape, including long and unknown choices", () => {
  assert.equal(validateRequests(requests).total, 4);
  const data = edgeRequests();
  const parsed = validateRequests(data);
  assert.deepEqual(parsed.input_requests[0].options, data.input_requests[0].options);
  assert.equal(parsed.permission_requests[2].decision_options, "future_choices");
  assert.equal(requests.permission_requests[2].decision_options, "accept_deny");
});
test("an unavailable selected conversation offers a retry without old content", () => {
  const html = content(undefined);
  assert.match(html, /Conversation unavailable/);
  assert.match(html, /Try again/);
  assert.doesNotMatch(html, /Alex is free|Saved conversation/);
});

test("only linked owner requests add attention labels to a conversation", () => {
  const sessions = [
    { session_id: "one", agent_kind: "codex", status: "active", last_used_at_ms: 0 },
    { session_id: "two", agent_kind: "hermes", status: "active", last_used_at_ms: 0 },
  ];
  const html = list(sessions, "two", new Map([["one", { total: 1, input_requests: [{}] }]]));
  assert.equal((html.match(/class="sr-only">Answer needed/g) || []).length, 1);
  assert.match(html, /aria-pressed="false"[^>]*>[\s\S]*Answer needed/);
  assert.doesNotMatch(list(sessions), /Answer needed|Approval needed/);
  assert.match(
    list(sessions, "one", new Map([["one", { total: 1, input_requests: [] }]])),
    /Approval needed/,
  );
});

test("conversation rows show saved topics and excerpts with accessible metadata", () => {
  const html = list([
    {
      session_id: "exact-id",
      agent_kind: "claude_code",
      last_used_at_ms: 0,
      status: "active",
      preview: { title: "Catch-up with Alex", excerpt: "Alex is busy before 4 pm <script>" },
    },
  ]);
  assert.match(html, /Catch-up with Alex/);
  assert.match(html, /Alex is busy before 4 pm &lt;script&gt;/);
  assert.match(html, /Claude Code/);
  assert.doesNotMatch(html, /<script>/);
});

test("styled disclosures keep native keyboard semantics and readable exact values", () => {
  const html = detail({
    scope: { path: "/Users/example/Project files", count: 0, enabled: false, empty: null },
    options: ["<script>plain text</script>", "Allow once"],
  });
  assert.match(html, /<details[^>]*class="[^"]*detail-disclosure/);
  assert.match(html, /<summary/);
  assert.match(html, /disclosure-chevron/);
  assert.match(html, /<dl/);
  assert.match(html, /Project files/);
  assert.match(html, />0</);
  assert.match(html, />false</);
  assert.match(html, />null</);
  assert.match(html, /&lt;script&gt;plain text/);
  assert.doesNotMatch(html, /<script>/);
});

test("chat distinguishes both agents, keeps owner notifications separate, and orders messages by time", () => {
  const entry = (id, role, text, createdAt) => ({ id, kind: "entry", role, text, createdAt });
  const page = {
    source: "archive",
    warnings: [],
    hasMore: false,
    nextCursor: 0,
    items: [
      entry("own", "agent", "Own reply", 3000),
      entry(
        "peer",
        "user",
        JSON.stringify({
          payload: {
            type: "action_call",
            action_type: "get_phone_number",
            payload: { reason: "Remote request" },
          },
        }),
        1000,
      ),
      entry(
        "owner",
        "user",
        JSON.stringify({ payload: { type: "owner_input", question: "Confirm?", value: "Yes" } }),
        2000,
      ),
    ],
  };
  const html = content(page);
  assert.ok(html.indexOf("Remote request") < html.indexOf("Your answer"));
  assert.ok(html.indexOf("Your answer") < html.indexOf("Own reply"));
  assert.match(html, /chat-peer/);
  assert.match(html, /chat-own/);
  assert.match(html, /chat-owner/);
  assert.match(html, /Your agent/);
  assert.match(html, /You · via Embassys/);
});

test("sidebar identifies the peer separately from the conversation topic", () => {
  const html = list([
    {
      session_id: "one",
      agent_kind: "codex",
      status: "active",
      last_used_at_ms: 0,
      peer: { name: "Alex <untrusted>", email: "alex@example.test", agentId: "exact-peer" },
      preview: { title: "Calendar availability", excerpt: "Local summary" },
    },
  ]);
  assert.match(html, /session-topic">Alex &lt;untrusted&gt;/);
  assert.match(html, /session-excerpt">Calendar availability/);
  assert.match(html, /alex@example.test/);
  assert.doesNotMatch(html, /<untrusted>/);
});
