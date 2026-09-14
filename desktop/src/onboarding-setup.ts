import type { DeviceReview } from "../../src/desktop/owner-devices.js";
import type { OwnerReply, OwnerSnapshot } from "../../src/desktop/owner-protocol.js";
import type { DesktopCommand } from "../../src/desktop/protocol.js";
import type { RegistrationSnapshot } from "../../src/desktop/registration.js";

export async function prepareOnboardingAgent(
  owner: OwnerSnapshot,
  registration: RegistrationSnapshot,
  instanceId: string,
  call: (command: DesktopCommand) => Promise<unknown>,
  approvedReview?: DeviceReview,
): Promise<{ registration?: RegistrationSnapshot; review?: DeviceReview }> {
  if (owner.status !== "signed_in" || !owner.account || !owner.email)
    throw new Error("Sign in again to finish setup.");
  if (registration.email && registration.email.toLowerCase() !== owner.email.toLowerCase())
    throw new Error(
      "This installation belongs to a different account. Choose another installation in Settings.",
    );
  if (
    !approvedReview &&
    registration.phase === "registered" &&
    registration.credentialStatus === "active"
  ) {
    const fresh = (await call({ type: "owner_profile", context: owner.context })) as OwnerReply;
    if (fresh.data?.kind !== "profile" || fresh.snapshot.context !== owner.context)
      throw new Error("Your agent assignment could not be checked. Try connecting again.");
    const agent = fresh.data.profile.agents.find((agent) => agent.email === owner.email);
    if (
      agent &&
      ((!agent.executor_device_id && !registration.executionDeviceId) ||
        (agent.executor_device_id === owner.account.device_id &&
          registration.executionDeviceId === agent.executor_device_id &&
          registration.executorEpoch === agent.executor_epoch))
    )
      return { registration };
  }
  let review = approvedReview;
  if (!review) {
    const created = (await call({
      type: "owner_create_agent",
      context: owner.context,
    })) as OwnerReply;
    if (created.data?.kind !== "agent_setup" || created.snapshot.context !== owner.context)
      throw new Error("Your agent setup could not be confirmed. Try again; your account is saved.");
    const result = (await call({
      type: "owner_device_review",
      context: owner.context,
      operation: "execute",
      device_id: owner.account.device_id,
      agent_id: created.data.agent.id,
    })) as OwnerReply;
    if (result.data?.kind !== "device_review")
      throw new Error("Review this device again to finish setup.");
    review = result.data;
    if (review.agent?.executor_device_id && review.agent.executor_device_id !== review.device.id)
      return { review };
  }
  const installed = (await call({
    type: "owner_device_submit",
    context: owner.context,
    review_id: review.review_id,
    instanceId,
  })) as OwnerReply;
  if (installed.data?.kind !== "device_result" || !installed.data.confirmed)
    throw new Error("Review this device again. The change was not confirmed.");
  if (!installed.data.local_ready)
    throw new Error(
      "Your agent is assigned here, but local setup did not finish. Try connecting again.",
    );
  const current = (await call({ type: "enrollment_status", instanceId })) as RegistrationSnapshot;
  if (
    current.phase !== "registered" ||
    current.email?.toLowerCase() !== owner.email.toLowerCase() ||
    current.credentialStatus !== "active"
  )
    throw new Error("This device could not confirm your saved agent. Try connecting again.");
  return { registration: current };
}
