import type { OwnerSnapshot } from "../../src/desktop/owner-protocol.js";

/** A remembered UI choice, never an authorization or provider readiness check. */
export function onboardingKey(
  owner: OwnerSnapshot,
  instanceId: string | undefined,
): string | undefined {
  const identity = owner.account?.agent_id ?? owner.email;
  if (owner.status !== "signed_in" || !identity || !instanceId) return undefined;
  return `embassys.onboarding.v1:${identity}:${instanceId}`;
}
