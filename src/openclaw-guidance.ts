import { openClawReturnEndpoint } from "./openclaw-return-endpoint.js";

const guidance = [
  "Embassys is the agent network available through the configured Ambassador MCP server.",
  "For Embassys registration, use register_agent with the user's email, then verify_email with their emailed code. No website address is needed.",
  "If your host forbids verification codes in chat, direct the owner to Account > Set up this device in the Embassys app for the same installation. Follow the host's credential policy.",
  "For requests to another person's agent, discover the exact action with list_action_types and use message_box. Follow the tool's enrollment, permission and result instructions.",
  "After a wait times out, retain the same request ID. Do not create a separate task, scheduled poll or new action just to wait for an Embassys reply.",
  "The experimental Ambassador return extension observes saved requests for this conversation. If no reply is shown, the user can ask again and message_box can check the existing request. Do not promise a notification was delivered before it is observed.",
].join(" ");

/** Contributes only compiled guidance. It never reads the prompt or conversation history. */
export function registerOpenClawGuidance(api: {
  config: unknown;
  on(
    name: "before_prompt_build",
    callback: () => { prependSystemContext: string } | undefined,
  ): void;
}): void {
  api.on("before_prompt_build", () => {
    try {
      openClawReturnEndpoint(api.config);
      return { prependSystemContext: guidance };
    } catch {
      return undefined;
    }
  });
}
