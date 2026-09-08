import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { AcpSessionStore } from "../acp-session-store.js";
import { ActionResultInbox } from "../action-result-inbox.js";
import type { GatewayPaths } from "../gateway-paths.js";
import { GatewayIdentity } from "../identity.js";
import { NotificationStore } from "../notification-store.js";
import { OutboundActions } from "../outbound-actions.js";
import { OwnerQuestions } from "../owner-questions.js";
import { PendingActionInbox } from "../pending-action-inbox.js";
import { desktopCredentialStores } from "./credential-stores.js";

export interface LocalSummary {
  readonly enrollment: Record<string, string | boolean>;
  readonly pendingCalls: number;
  readonly receivedResults: number;
  readonly savedOutboundRequests: number;
  readonly savedOwnerQuestions: number;
  readonly unresolvedNotifications: number;
  readonly sessionCount: number;
}

/** The caller must hold the stopped instance's process lock throughout this read. */
export async function readLocalSummary(paths: GatewayPaths): Promise<LocalSummary> {
  const identity = await GatewayIdentity.open(desktopCredentialStores(paths).credentialStore);
  const stores: { close(): void }[] = [];
  try {
    const sessions = new AcpSessionStore(paths.acpSessionPath);
    stores.push(sessions);
    const summary = {
      enrollment: identity.enrollment,
      pendingCalls: 0,
      receivedResults: 0,
      savedOutboundRequests: 0,
      savedOwnerQuestions: 0,
      unresolvedNotifications: 0,
      sessionCount: sessions.list().length,
    };
    if (!identity.enrolled) {
      const encrypted = new Set([
        basename(paths.pendingActionPath),
        basename(paths.actionResultPath),
        basename(paths.outboundActionPath),
        "owner-questions.sqlite",
        "notification-custody.sqlite",
        "human-input-responses.sqlite",
        "operations.sqlite",
        "visible-transcripts.sqlite",
      ]);
      const files = await readdir(paths.stateDirectory);
      if (files.some((name) => encrypted.has(name.replace(/-(?:wal|shm)$/u, ""))))
        throw new Error("The local identity is missing, so saved work cannot be counted safely.");
      return summary;
    }
    const credential = identity.localCredential();
    const pending = new PendingActionInbox(paths.pendingActionPath, credential);
    stores.push(pending);
    const results = new ActionResultInbox(paths.actionResultPath, credential);
    stores.push(results);
    const forbidden = async (): Promise<never> => {
      throw new Error("Summary reads cannot submit requests.");
    };
    const outbound = new OutboundActions(paths.outboundActionPath, credential, {
      requestPermission: forbidden,
      callAction: forbidden,
    });
    stores.push(outbound);
    const questions = new OwnerQuestions({
      path: join(paths.stateDirectory, "owner-questions.sqlite"),
      credential,
      pending,
      transport: { requestHumanInput: forbidden },
      enqueueContinuation: () => {
        throw new Error("Summary reads cannot deliver.");
      },
    });
    stores.push(questions);
    const notifications = new NotificationStore(
      join(paths.stateDirectory, "notification-custody.sqlite"),
      credential,
    );
    stores.push(notifications);
    return {
      ...summary,
      pendingCalls: pending.count(),
      receivedResults: results.count(),
      savedOutboundRequests: outbound.count(),
      savedOwnerQuestions: questions.count(),
      unresolvedNotifications: notifications.unresolvedCount(),
    };
  } finally {
    for (const store of stores.reverse()) store.close();
  }
}
