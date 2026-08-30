export type K04IpcBoundary =
  | "connector_parent"
  | "gateway_parent"
  | "connector_child"
  | "gateway_child";

const SHARED_PROCESS_BARRIERS = new Set([
  "startup",
  "readiness",
  "operation",
  "commit",
  "response",
  "teardown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function isSharedProcessBarrier(value: unknown, kind: string): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["kind", "name", "sequence"]) &&
    value.kind === kind &&
    typeof value.name === "string" &&
    SHARED_PROCESS_BARRIERS.has(value.name) &&
    Number.isSafeInteger(value.sequence) &&
    (value.sequence as number) >= 1
  );
}

export function parseK04IpcEnvelope(
  boundary: K04IpcBoundary,
  value: unknown,
):
  | { readonly kind: "shared" }
  | { readonly kind: "k04"; readonly message: Record<string, unknown> } {
  const parent = boundary === "connector_parent" || boundary === "gateway_parent";
  if (
    isSharedProcessBarrier(value, parent ? "a2a-t02-barrier-arrival" : "a2a-t02-barrier-release")
  ) {
    return { kind: "shared" };
  }
  const channel =
    boundary === "connector_parent"
      ? "k04"
      : boundary === "gateway_parent"
        ? "k04_gateway_fetch"
        : boundary === "connector_child"
          ? "k04_control"
          : "k04_gateway_fetch_control";
  if (!isRecord(value) || value.channel !== channel) {
    throw new Error("unexpected K04 IPC envelope or channel");
  }
  return { kind: "k04", message: value };
}
