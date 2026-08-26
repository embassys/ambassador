// The MCP SDK mirrors this JSON as structured content and an escaped text item.
// This cap keeps both copies and a maximum-size request ID below the 4 MiB transport limit.
const MAX_LOCAL_TOOL_RESULT_BYTES = 512 * 1024;

export class LocalToolResultTooLarge extends Error {
  constructor() {
    super("Local tool result exceeded its size limit");
    this.name = "LocalToolResultTooLarge";
  }
}

export function serializeLocalToolResult(result: Record<string, unknown>): string {
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized, "utf8") > MAX_LOCAL_TOOL_RESULT_BYTES) {
    throw new LocalToolResultTooLarge();
  }
  return serialized;
}
