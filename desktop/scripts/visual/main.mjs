// Standalone visual test host: no gateway, accounts, credentials, network or provider processes.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeTheme,
  protocol,
  session,
  systemPreferences,
} from "electron";
import { controlPalette, windowAppearance } from "../../../src/desktop/appearance.ts";
import {
  conversationPreview,
  decorateConversationSessions,
} from "../../../src/desktop/conversation-preview.ts";
import { parseDesktopCommand } from "../../../src/desktop/protocol.ts";
import { applicationMenu } from "../../src/application-menu.ts";
import {
  communications,
  edgeRequests,
  histories,
  instanceId,
  owner,
  requests,
  sessions,
} from "./data.mjs";

const root = dirname(fileURLToPath(import.meta.url));
let chatReads = 0;
if (process.argv.includes("--people-start")) {
  sessions.splice(0);
  requests.permission_requests.splice(0);
  requests.input_requests.splice(0);
  requests.total = 0;
}
let people = process.argv.includes("--people-start")
  ? []
  : [
      { name: "Alex Morgan", email: "alex@fixture.test" },
      { name: "Sam Rivera", email: "sam@fixture.test" },
      { name: "Priya Patel", email: "priya@fixture.test" },
      { name: "Jordan Lee", email: "jordan@fixture.test" },
      { name: "Taylor Kim", email: "taylor@fixture.test" },
    ];
if (process.argv.includes("--chat-pages")) {
  const page = histories[sessions[0].session_id];
  page.items.unshift(
    ...Array.from({ length: 60 }, (_, n) => ({
      id: `older-chat-${n}`,
      kind: "entry",
      role: "agent",
      sessionId: sessions[0].session_id,
      messageId: `old-message-${n}`,
      createdAt: Date.parse("2026-09-09T10:00:00Z") + n * 60000,
      text: `Earlier saved message ${n + 1}. This is fictional content for checking history pagination.`,
    })),
  );
}
protocol.registerSchemesAsPrivileged([
  { scheme: "ambassador", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
app.setName("Embassys Visual Review");
let appearance = "light",
  state = "running",
  settingsRequest,
  review;
const pending = process.argv.includes("--edge-cases") ? edgeRequests() : structuredClone(requests);
const instance = {
  id: instanceId,
  name: "Sample data · this Mac",
  port: 8787,
  stateDirectory: join(root, "sample-state"),
  workingDirectory: root,
  enabled: true,
  createdAt: "2026-09-10T08:00:00Z",
};
const sampleDevices = [
  {
    id: owner.account.device_id,
    device_name: "Morgan’s MacBook Pro",
    platform: "darwin",
    jkt: "fixture-key",
    created_at: "2026-09-14T09:00:00Z",
    last_seen_at: "2026-09-14T10:00:00Z",
    revoked_at: null,
    executes_agent_ids: [owner.account.agents[0].id],
    is_current: true,
  },
  {
    id: "00000000-0000-4000-8000-000000000007",
    device_name: "Home computer",
    platform: "linux",
    jkt: "fixture-other-key",
    created_at: "2026-09-12T09:00:00Z",
    last_seen_at: "2026-09-13T10:00:00Z",
    revoked_at: null,
    executes_agent_ids: [],
    is_current: false,
  },
];
const sampleInvitations = [
  {
    invitation_id: "00000000-0000-4000-8000-000000000082",
    direction: "incoming",
    state: "pending",
    other_email: "alex@fixture.test",
    other_name: "Alex Morgan",
    inviter_email: "alex@fixture.test",
    invitee_email: owner.email,
    created_at: "2026-09-14T10:00:00Z",
    responded_at: null,
    delivered: true,
  },
];
let win;
function changed() {
  win?.webContents.send("ambassador:changed");
}
function snapshot() {
  const dark = appearance === "dark";
  return {
    platform: process.platform,
    diagnosticsMode: "development",
    appearance,
    dark,
    focused: win?.isFocused() ?? true,
    reducedTransparency: false,
    notifications: { enabled: false, supported: true },
    settingsRequest,
    palette: controlPalette(systemPreferences.getAccentColor(), dark),
    appVersion: "Sample data",
    build: "Offline visual review",
    cliCommand: "ambassador",
    loginItem: { supported: false, enabled: false, reason: "Visual review" },
    owner,
    instances: [
      { ...instance, runtime: { id: instanceId, state, endpoint: "http://127.0.0.1:8787/mcp" } },
    ],
  };
}
function reply(data) {
  return { state: "ready", snapshot: owner, data, fetchedAt: "2026-09-10T10:45:00Z" };
}
async function start() {
  await app.whenReady();
  nativeTheme.themeSource = "light";
  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, cb) =>
    cb({ cancel: !details.url.startsWith("ambassador://app/") }),
  );
  const assets = {
    "/index.html": ["index.html", "text/html"],
    "/app.js": ["app.js", "text/javascript"],
    "/styles.css": ["styles.css", "text/css"],
    "/brand.svg": ["brand.svg", "image/svg+xml"],
  };
  protocol.handle("ambassador", async (req) => {
    const u = new URL(req.url),
      a = assets[u.pathname];
    if (u.host !== "app" || req.method !== "GET" || !a) return new Response(null, { status: 404 });
    return new Response(await readFile(join(root, a[0])), {
      headers: {
        "Content-Type": a[1],
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'",
      },
    });
  });
  ipcMain.handle("ambassador:command", async (event, input) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame)
      return { ok: false, error: "Untrusted visual review" };
    try {
      const cmd = parseDesktopCommand(input);
      let result;
      switch (cmd.type) {
        case "snapshot":
          result = snapshot();
          break;
        case "overview":
          result = {
            enrollment: {
              status: "enrolled",
              email: owner.email,
              agent_id: owner.account.agents[0].id,
            },
            pendingCalls: 2,
            receivedResults: 0,
            sessionCount: sessions.length,
          };
          break;
        case "owner_status":
          result = reply();
          break;
        case "owner_profile":
          result = reply({ kind: "profile", profile: owner.account });
          break;
        case "owner_requests":
          result = reply(pending);
          break;
        case "owner_devices":
          result = reply({ kind: "devices", devices: sampleDevices });
          break;
        case "owner_device_review":
          review = {
            kind: "device_review",
            review_id: randomUUID(),
            expires_at: new Date(Date.now() + 300000).toISOString(),
            operation: cmd.operation,
            device: sampleDevices.find((device) => device.id === cmd.device_id),
            ...(cmd.agent_id ? { agent: owner.account.agents[0] } : {}),
          };
          result = reply(review);
          break;
        case "owner_device_submit":
          result = reply({
            kind: "device_result",
            operation: review.operation,
            device_id: review.device.id,
            confirmed: true,
            executes_here: review.device.is_current,
            local_ready: true,
          });
          review = undefined;
          break;
        case "owner_invitations":
          result = reply({
            kind: "invitations",
            next_cursor: null,
            has_more: false,
            invitations: sampleInvitations,
          });
          break;
        case "owner_connections":
          result = reply({
            kind: "connections",
            next_cursor: null,
            has_more: false,
            connections: [
              {
                invitation_id: "00000000-0000-4000-8000-000000000081",
                email: "sam@fixture.test",
                name: "Sam Rivera",
                connected_at: "2026-09-14T10:00:00Z",
              },
            ],
          });
          break;
        case "owner_invitation_answer": {
          const invitation = sampleInvitations.find(
            (item) => item.invitation_id === cmd.invitation_id,
          );
          invitation.state = cmd.answer === "accept" ? "accepted" : "declined";
          result = reply({ kind: "invitation", invitation, created: false });
          break;
        }
        case "owner_invite": {
          const invitation = {
            ...sampleInvitations[0],
            invitation_id: randomUUID(),
            direction: "outgoing",
            state: "pending",
            other_email: cmd.email,
            invitee_email: cmd.email,
            other_name: people.find((person) => person.email === cmd.email)?.name ?? null,
            inviter_email: owner.email,
          };
          sampleInvitations.push(invitation);
          result = reply({ kind: "invitation", invitation, created: true });
          break;
        }
        case "owner_permissions":
          result = reply({ kind: "permissions", direction: cmd.direction, permissions: [] });
          break;
        case "owner_people":
          result = reply({ kind: "people", contacts: people });
          break;
        case "owner_people_save":
          for (const person of cmd.contacts) {
            const current = people.findIndex((p) => p.email === person.email);
            if (current < 0) people.push(person);
            else if (cmd.replace) people[current] = person;
          }
          result = reply({ kind: "people", contacts: people });
          break;
        case "owner_people_remove":
          people = people.filter((p) => p.email !== cmd.email);
          result = reply({ kind: "people", contacts: people });
          break;
        case "owner_communications":
          result = reply({ kind: "communications", communications });
          break;
        case "owner_review": {
          const item = (
            cmd.kind === "permission" ? pending.permission_requests : pending.input_requests
          ).find((x) => x.id === cmd.id);
          if (!item) throw new Error("The sample request is unavailable.");
          review = {
            kind: "review",
            review_id: randomUUID(),
            expires_at: new Date(Date.now() + 300000).toISOString(),
            target: { kind: cmd.kind, item },
          };
          result = reply(review);
          break;
        }
        case "owner_submit": {
          if (!review || review.review_id !== cmd.review_id)
            throw new Error("Sample review expired.");
          const target = review.target;
          pending.permission_requests = pending.permission_requests.filter(
            (x) => x.id !== target.item.id,
          );
          pending.input_requests = pending.input_requests.filter((x) => x.id !== target.item.id);
          pending.total--;
          result = reply({
            kind: "mutation",
            status: "confirmed",
            mutation: {
              id: target.item.id,
              kind: target.kind,
              action_type: target.item.action_type,
              status: "confirmed",
              updated_at: new Date().toISOString(),
            },
          });
          review = undefined;
          break;
        }
        case "request_links":
          result = {
            agentId: owner.account.agents[0].id,
            links:
              state === "running" && requests.input_requests.length > 0
                ? [
                    {
                      kind: "input",
                      requestId: requests.input_requests[0].id,
                      sessionId: sessions[0].session_id,
                    },
                  ]
                : [],
            hasMore: false,
            nextCursor: 1,
          };
          break;
        case "sessions":
          result = decorateConversationSessions(sessions, (id) =>
            conversationPreview(histories[id]?.items ?? []),
          );
          break;
        case "history":
          if (!histories[cmd.sessionId]) throw new Error("Sample unreadable conversation");
          {
            const page = histories[cmd.sessionId];
            if (
              process.argv.includes("--chat-pages") &&
              cmd.sessionId === sessions[0].session_id &&
              ++chatReads === 2
            ) {
              page.items.push({
                id: "live-chat-sample",
                kind: "entry",
                role: "agent",
                sessionId: cmd.sessionId,
                messageId: "new-sample",
                createdAt: Date.parse("2026-09-10T10:43:00Z"),
                text: "New sample reply arrived while you were reading. Your scroll position should stay unchanged.",
              });
            }
            const end = Math.min(page.items.length, (cmd.before ?? Number.MAX_SAFE_INTEGER) - 1);
            const start = Math.max(0, end - 50);
            result = {
              ...page,
              items: page.items.slice(start, end),
              hasMore: start > 0,
              nextCursor: start + 1,
            };
          }
          break;
        case "set_appearance":
          appearance = cmd.appearance === "system" ? "light" : cmd.appearance;
          nativeTheme.themeSource = appearance;
          changed();
          result = snapshot();
          break;
        case "start":
          state = "running";
          changed();
          result = {};
          break;
        case "stop":
          state = "stopped";
          changed();
          result = {};
          break;
        case "history_delete":
          throw new Error("Deletion is disabled in this visual review.");
        default:
          throw new Error("This operation is unavailable in the offline visual review.");
      }
      return { ok: true, result };
    } catch {
      return { ok: false, error: "This operation is unavailable in the offline visual review." };
    }
  });
  ipcMain.handle("ambassador:copy", () => {});
  win = new BrowserWindow({
    width: 840,
    height: 680,
    minWidth: 680,
    minHeight: 540,
    title: "Embassys · Sample data",
    ...windowAppearance(process.platform, false, false),
    webPreferences: {
      preload: join(root, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.on("focus", changed);
  win.on("blur", changed);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      applicationMenu(process.platform, () => {
        settingsRequest = randomUUID();
        changed();
      }),
    ),
  );
  await win.loadURL("ambassador://app/index.html");
  app.on("window-all-closed", () => app.quit());
}
void start();
