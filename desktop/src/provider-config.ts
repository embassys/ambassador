import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";
import { isAlias, isMap, parseDocument, visit } from "yaml";
import type {
  ConnectionDocument,
  ConnectionProvider,
} from "../../src/desktop/agent-connections.js";

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
function entry(parsed: unknown): unknown {
  if (!record(parsed) || (parsed.mcp_servers !== undefined && !record(parsed.mcp_servers)))
    throw new Error("Invalid MCP configuration.");
  return record(parsed.mcp_servers) ? parsed.mcp_servers.ambassador : undefined;
}
function unrelated(parsed: unknown) {
  if (!record(parsed)) throw new Error("Invalid configuration.");
  const copy = structuredClone(parsed);
  if (record(copy.mcp_servers)) {
    delete copy.mcp_servers.ambassador;
    if (!Object.keys(copy.mcp_servers).length) delete copy.mcp_servers;
  }
  return copy;
}
function yamlDocument(text: string) {
  const document = parseDocument(text, { uniqueKeys: true, strict: true, merge: false });
  if (document.errors.length || (document.contents !== null && !isMap(document.contents)))
    throw new Error("Invalid YAML configuration.");
  visit(document, {
    Node(_key, node) {
      if (isAlias(node)) throw new Error("Use manual setup for YAML aliases.");
    },
    Pair(_key, pair) {
      if (String(pair.key) === "<<") throw new Error("Use manual setup for YAML merge keys.");
    },
  });
  return document;
}
const tomlDocument: ConnectionDocument = {
  read: (text) => entry(parseToml(text)),
  edit(text, value) {
    const before = parseToml(text);
    const existing = entry(before);
    let updated = text;
    if (existing !== undefined) {
      // Only edit a standalone table. Quoted, inline and nested layouts remain manual.
      const header = /^\[mcp_servers\.ambassador\][ \t]*(?:#[^\r\n]*)?\r?$/mu.exec(text);
      if (!header || !record(existing)) throw new Error("Use manual setup for this TOML layout.");
      const rest = text.slice(header.index + header[0].length);
      const next = /^\s*\[/mu.exec(rest);
      const end = next ? header.index + header[0].length + next.index : text.length;
      const section = text.slice(header.index, end);
      // Keep standalone comments even when removing our table.
      const comments = section
        .split(/\r?\n/u)
        .filter((line) => /^\s*#/u.test(line))
        .join("\n");
      updated = text.slice(0, header.index) + (comments ? `${comments}\n` : "") + text.slice(end);
    }
    if (value)
      updated += `${updated.endsWith("\n") || !updated ? "" : "\n"}\n[mcp_servers.ambassador]\nurl = ${JSON.stringify(value.url)}\ntool_timeout_sec = 660\n`;
    const after = parseToml(updated);
    if (
      !isDeepStrictEqual(unrelated(before), unrelated(after)) ||
      !isDeepStrictEqual(entry(after), value)
    )
      throw new Error("The TOML edit would affect other settings.");
    return updated;
  },
};
const hermesDocument: ConnectionDocument = {
  read: (text) => entry(yamlDocument(text).toJS() ?? {}),
  edit(text, value) {
    const document = yamlDocument(text);
    const before: unknown = document.toJS() ?? {};
    entry(before);
    if (value) document.setIn(["mcp_servers", "ambassador"], value);
    else document.deleteIn(["mcp_servers", "ambassador"]);
    const updated = document.toString();
    const after: unknown = yamlDocument(updated).toJS() ?? {};
    if (
      !isDeepStrictEqual(unrelated(before), unrelated(after)) ||
      !isDeepStrictEqual(entry(after), value)
    )
      throw new Error("The YAML edit would affect other settings.");
    return updated;
  },
};
export function providerDocument(provider: ConnectionProvider): ConnectionDocument | undefined {
  return provider === "codex" ? tomlDocument : provider === "hermes" ? hermesDocument : undefined;
}
