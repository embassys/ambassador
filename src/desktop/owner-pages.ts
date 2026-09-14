import type { OwnerCommand, OwnerReply, OwnerView } from "./owner-protocol.js";

type Requests = Extract<OwnerView, { kind: "requests" }>;
/** A bounded sidebar snapshot. The final cursor remains visible if more pages exist. */
export async function collectOwnerRequests(
  context: string,
  read: (command: OwnerCommand) => Promise<OwnerReply>,
): Promise<OwnerReply> {
  let cursor: string | undefined;
  let last: OwnerReply | undefined;
  let data: Requests | undefined;
  const seen = new Set<string>();
  const permissions = new Map<string, Requests["permission_requests"][number]>();
  const questions = new Map<string, Requests["input_requests"][number]>();
  for (let page = 0; page < 20; page++) {
    last = await read({ type: "owner_requests", context, ...(cursor ? { cursor } : {}) });
    if (last.snapshot.context !== context || last.snapshot.status !== "signed_in")
      throw new Error("Account changed");
    if (last.state !== "ready" || last.data?.kind !== "requests") return last;
    data = last.data;
    for (const item of data.permission_requests) permissions.set(item.id, item);
    for (const item of data.input_requests) questions.set(item.id, item);
    if (!data.has_more) break;
    if (!data.next_cursor || seen.has(data.next_cursor)) throw new Error("Invalid request cursor");
    seen.add(data.next_cursor);
    cursor = data.next_cursor;
  }
  if (!last || !data) throw new Error("Requests unavailable");
  return {
    ...last,
    data: {
      ...data,
      permission_requests: [...permissions.values()],
      input_requests: [...questions.values()],
      total: permissions.size + questions.size,
    },
  };
}
