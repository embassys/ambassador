import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { NativeBoxClient } from "../../dist/native-box-client.js";
import {
  NativeConversationBridge,
  NativeRouteStore,
} from "../../dist/native-conversation-bridge.js";
import { registerOpenClawGuidance } from "../../dist/openclaw-guidance.js";
import { registerOpenClawBridge } from "../../dist/openclaw-native-bridge.js";
import { nativeRouteNamespace } from "../../dist/openclaw-return-endpoint.js";
import { ProcessLock } from "../../dist/process-lock.js";

// OpenClaw activates tools separately from gateway services. Both registrations
// must reference the same process-owned observer and lifecycle.
const stateKey = Symbol.for("@embassys/ambassador/openclaw-conversation-return/v1");
globalThis[stateKey] ??= {};
const bridgeState = globalThis[stateKey];

export default {
  id: "ambassador-conversation-return",
  register(api) {
    registerOpenClawGuidance(api);
    registerOpenClawBridge(
      api,
      async (stateDir, endpoint) => {
        const client = new NativeBoxClient(endpoint);
        const lock = await ProcessLock.acquire(
          join(stateDir, "ambassador-conversation-return", "bridge.lock"),
        );
        let store;
        try {
          const routeDirectory = join(
            stateDir,
            "ambassador-conversation-return",
            nativeRouteNamespace(endpoint),
          );
          await mkdir(routeDirectory, { recursive: true, mode: 0o700 });
          store = new NativeRouteStore(join(routeDirectory, "routes.sqlite"));
        } catch (error) {
          store?.close();
          await client.close();
          await lock.release();
          throw error;
        }
        const bridge = new NativeConversationBridge({
          store,
          presentation: "assistant_message",
          async isConversationIdle(sessionKey, signal) {
            const history = await callGatewayFromCli(
              "chat.history",
              { timeout: "15000" },
              { sessionKey, limit: 1 },
              { signal, progress: false, sharedStateMode: "read-only" },
            );
            const info = history.sessionInfo;
            if (info?.key !== sessionKey || typeof info.hasActiveRun !== "boolean")
              throw new Error("Conversation activity could not be confirmed");
            return !info.hasActiveRun;
          },
          async callBox(input, signal) {
            return client.call(input, signal);
          },
          async deliver(sessionKey, message, signal) {
            const result = await callGatewayFromCli(
              "chat.inject",
              { timeout: "30000" },
              { sessionKey, message, label: "Ambassador" },
              { signal, progress: false, sharedStateMode: "read-only" },
            );
            return result.ok === true && typeof result.messageId === "string"
              ? "accepted"
              : "unavailable";
          },
          notice: () =>
            api.logger.warn(
              "Ambassador native delivery paused. The result remains available through message_box.",
            ),
        });
        return {
          bind: bridge.bind.bind(bridge),
          observe: bridge.observe.bind(bridge),
          resume: bridge.resume.bind(bridge),
          async close() {
            await bridge.close();
            await client.close();
            store.close();
            await lock.release();
          },
        };
      },
      bridgeState,
    );
  },
};
