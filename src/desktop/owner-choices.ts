// Deployed models.DECISION_OPTION_CHOICES and email_service.option_sets.
// Unknown menu names have no fallback. Provider input choices never use this table.
export const permissionMenus = {
  accept_deny: [
    { value: "deny", label: "Deny" },
    { value: "accept", label: "Accept" },
  ],
  once_always: [
    { value: "deny", label: "Deny" },
    { value: "allow_once", label: "Allow once" },
    { value: "allow_always", label: "Allow always" },
  ],
} as const;
export function permissionChoices(
  menu: string | null,
): readonly { value: string; label: string }[] {
  return menu === "accept_deny" || menu === "once_always" ? permissionMenus[menu] : [];
}
