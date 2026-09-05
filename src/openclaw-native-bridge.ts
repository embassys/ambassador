import { z } from "zod";
import type { NativeConversationBridge } from "./native-conversation-bridge.js";

interface ToolEvent {
  toolName: string;
  params: Record<string, unknown>;
}
interface ToolContext {
  sessionKey?: string;
}
interface ProviderApi {
  on(
    name: "before_tool_call" | "after_tool_call",
    callback: (event: ToolEvent, context: ToolContext) => Promise<unknown>,
  ): void;
  registerService(service: {
    id: string;
    start(context: { stateDir: string }): Promise<void>;
    stop(): Promise<void>;
  }): void;
  logger: { warn(message: string): void };
}
type Bridge = Pick<NativeConversationBridge, "bind" | "observe" | "resume" | "close">;
export interface OpenClawBridgeState {
  bridge?: Bridge | undefined;
  stateDirectory?: string | undefined;
  starting?: Promise<void> | undefined;
}
function eligible(event: ToolEvent, context: ToolContext): boolean {
  return (
    ["ambassador__message_box", "mcp__ambassador__message_box", "ambassador.message_box"].includes(
      event.toolName,
    ) &&
    ["request_action", "request_permission"].includes(String(event.params.type)) &&
    z.uuid().safeParse(event.params.request_id).success &&
    typeof context.sessionKey === "string" &&
    context.sessionKey.length > 0 &&
    context.sessionKey.length <= 512
  );
}
/** Registration seam uses OpenClaw's reviewed hook and service contracts. */
export function registerOpenClawBridge(
  api: ProviderApi,
  create: (stateDirectory: string) => Promise<Bridge>,
  state: OpenClawBridgeState = {},
): void {
  async function ensureBridge(): Promise<void> {
    if (state.bridge !== undefined || state.stateDirectory === undefined) return;
    if (state.starting !== undefined) return state.starting;
    const directory = state.stateDirectory;
    state.starting = (async () => {
      try {
        const created = await create(directory);
        if (state.stateDirectory !== directory) {
          await created.close();
          return;
        }
        state.bridge = created;
        void created
          .resume()
          .catch(() =>
            api.logger.warn("Ambassador native delivery paused; results remain in message_box."),
          );
      } catch {
        api.logger.warn(
          "Ambassador native delivery is unavailable; use message_box waits and checks.",
        );
      }
    })().finally(() => {
      state.starting = undefined;
    });
    return state.starting;
  }
  api.registerService({
    id: "ambassador-conversation-return",
    async start(context) {
      state.stateDirectory = context.stateDir;
      await ensureBridge();
    },
    async stop() {
      state.stateDirectory = undefined;
      await state.starting;
      await state.bridge?.close();
      state.bridge = undefined;
    },
  });
  api.on("before_tool_call", async (event, context) => {
    if (!eligible(event, context)) return;
    await ensureBridge();
    if (state.bridge === undefined) return;
    try {
      state.bridge.bind(event.params.request_id as string, context.sessionKey as string);
      // Preserve the foreground wait until the desktop's live rendering path
      // is qualified. Codex's native relay also rejects argument rewrites.
      return;
    } catch {
      api.logger.warn(
        "Ambassador kept the foreground wait because its conversation could not be bound.",
      );
      return;
    }
  });
  api.on("after_tool_call", async (event, context) => {
    if (!eligible(event, context)) return;
    await ensureBridge();
    if (state.bridge === undefined) return;
    try {
      // Codex completion telemetry can arrive without a before hook. Its
      // session key is still provider context, never a tool-supplied origin.
      state.bridge.bind(event.params.request_id as string, context.sessionKey as string);
    } catch {
      api.logger.warn("Ambassador could not bind this conversation; check the saved request.");
      return;
    }
    void state.bridge
      .observe(event.params.request_id as string)
      .catch(() => api.logger.warn("Ambassador native delivery paused; check the saved request."));
  });
}
