import type { OwnerSnapshot } from "../../src/desktop/owner-protocol.js";

/** A remembered UI choice, never an authorization or provider readiness check. */
export function onboardingKey(
  owner: OwnerSnapshot,
  instanceId: string | undefined,
): string | undefined {
  const identity = owner.account?.owner_id ?? owner.email;
  if (owner.status !== "signed_in" || !identity || !instanceId) return undefined;
  return `embassys.onboarding.v1:${identity}:${instanceId}`;
}

export type OnboardingAgentChoice = { index: number; chosen: boolean };
export type OnboardingAgentChoiceEvent = { type: "choose" | "loaded"; index: number };

export function updateOnboardingAgentChoice(
  state: OnboardingAgentChoice,
  event: OnboardingAgentChoiceEvent,
): OnboardingAgentChoice {
  if (event.type === "loaded" && state.chosen) return state;
  return { index: event.index, chosen: event.type === "choose" || state.chosen };
}
