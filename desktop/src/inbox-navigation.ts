import { requestItems } from "./account.js";
import type { RequestSnapshot } from "./conversation-workspace.js";

export function inboxEntries(data: RequestSnapshot | undefined) {
  if (!data) return [];
  const uncertain = new Set(data.unconfirmed?.map((item) => `${item.kind}:${item.id}`));
  const entries = requestItems(data).map((entry) => ({
    key: `${entry.kind}:${entry.item.id}`,
    label:
      entry.kind === "permission"
        ? entry.item.requester_name || entry.item.requester_email || "Permission request"
        : "Question",
    detail:
      entry.kind === "permission"
        ? entry.item.action_description || entry.item.action_type.replaceAll("_", " ")
        : entry.item.prompt,
    uncertain: uncertain.has(`${entry.kind}:${entry.item.id}`),
  }));
  const known = new Set(entries.map((entry) => entry.key));
  for (const item of data.unconfirmed ?? []) {
    const key = `${item.kind}:${item.id}`;
    if (known.has(key)) continue;
    known.add(key);
    entries.push({
      key,
      label: "Awaiting confirmation",
      detail: item.action_type.replaceAll("_", " "),
      uncertain: true,
    });
  }
  return entries;
}

export function selectInboxRequest(data: RequestSnapshot, key: string): RequestSnapshot {
  if (!key) return data;
  const permission_requests = data.permission_requests.filter((r) => `permission:${r.id}` === key);
  const input_requests = data.input_requests.filter((r) => `input:${r.id}` === key);
  return {
    ...data,
    permission_requests,
    input_requests,
    total: permission_requests.length + input_requests.length,
    unconfirmed: data.unconfirmed?.filter((r) => `${r.kind}:${r.id}` === key) ?? [],
    unconfirmedMore: false,
  };
}
