import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const forbiddenControls = [
  "connector_test_crash",
  "crashAfter",
  "crashAfterCancellation",
  "crashAfterLostReplyUncertain",
  "crashAfterReceived",
  "crashAfterTurnStarting",
  "crashAtUnboundState",
  "crashForRecoveryState",
  "failPairedStateWriteAfter",
  "failStateAfter",
  "filesystemQualification",
  "proveNoProviderDispatch",
  "providerDispatchDelayMsForTest",
  "stallWebhookResponseAfterCommit",
  "stateActionObserverForTest",
];

function skipQuoted(source, start, quote) {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === quote) return index + 1;
  }
  throw new Error("unterminated JavaScript string");
}

function skipComment(source, start) {
  if (source[start + 1] === "/") {
    const newline = source.indexOf("\n", start + 2);
    return newline === -1 ? source.length : newline + 1;
  }
  if (source[start + 1] === "*") {
    const end = source.indexOf("*/", start + 2);
    if (end === -1) throw new Error("unterminated JavaScript comment");
    return end + 2;
  }
  return start + 1;
}

function nextCodeIndex(source, start) {
  let index = start;
  while (index < source.length) {
    if (/\s/u.test(source[index])) {
      index += 1;
      continue;
    }
    if (source[index] === "/" && ["/", "*"].includes(source[index + 1])) {
      index = skipComment(source, index);
      continue;
    }
    return index;
  }
  return index;
}

function matchingDelimiter(source, start, open, close) {
  if (source[start] !== open) throw new Error("missing JavaScript delimiter");
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (['"', "'", "`"].includes(character)) {
      index = skipQuoted(source, index, character) - 1;
      continue;
    }
    if (character === "/" && ["/", "*"].includes(source[index + 1])) {
      index = skipComment(source, index) - 1;
      continue;
    }
    if (character === open) depth += 1;
    if (character !== close) continue;
    depth -= 1;
    if (depth === 0) return index;
  }
  throw new Error("unbalanced JavaScript delimiter");
}

function statementEnd(source, start) {
  const first = nextCodeIndex(source, start);
  if (source[first] === "{") return matchingDelimiter(source, first, "{", "}") + 1;
  const depths = { "(": 0, "[": 0, "{": 0 };
  for (let index = first; index < source.length; index += 1) {
    const character = source[index];
    if (['"', "'", "`"].includes(character)) {
      index = skipQuoted(source, index, character) - 1;
      continue;
    }
    if (character === "/" && ["/", "*"].includes(source[index + 1])) {
      index = skipComment(source, index) - 1;
      continue;
    }
    if (character === "(") depths["("] += 1;
    else if (character === ")") depths["("] -= 1;
    else if (character === "[") depths["["] += 1;
    else if (character === "]") depths["["] -= 1;
    else if (character === "{") depths["{"] += 1;
    else if (character === "}") depths["{"] -= 1;
    else if (character === ";" && Object.values(depths).every((depth) => depth === 0)) {
      return index + 1;
    }
  }
  throw new Error("unterminated JavaScript statement");
}

function lineStart(source, index) {
  const newline = source.lastIndexOf("\n", index - 1);
  const start = newline === -1 ? 0 : newline + 1;
  return /^\s*$/u.test(source.slice(start, index)) ? start : index;
}

function lineEnd(source, index) {
  let end = index;
  while (end < source.length && /[ \t]/u.test(source[end])) end += 1;
  if (source[end] === "\n") end += 1;
  return end;
}

function removeNamedBlock(source, prefix, name) {
  const marker = `${prefix}${name}(`;
  const start = source.indexOf(marker);
  if (start === -1 || source.indexOf(marker, start + 1) !== -1) {
    throw new Error(`unexpected emitted block ${name}`);
  }
  const bodyStart = source.indexOf("{", start + marker.length);
  if (bodyStart === -1) throw new Error(`missing emitted block body ${name}`);
  const bodyEnd = matchingDelimiter(source, bodyStart, "{", "}") + 1;
  return `${source.slice(0, lineStart(source, start))}${source.slice(lineEnd(source, bodyEnd))}`;
}

function forbidden(source) {
  return (
    forbiddenControls.some((control) => source.includes(control)) ||
    /\b[A-Za-z_$][\w$]*ForTest\b/u.test(source)
  );
}

function removeForbiddenIfStatements(source) {
  let output = source;
  let removed = 0;
  for (;;) {
    const matches = [...output.matchAll(/\bif\s*\(/gu)];
    const target = matches.find((match) => {
      const open = output.indexOf("(", match.index);
      const close = matchingDelimiter(output, open, "(", ")");
      return forbidden(output.slice(open + 1, close));
    });
    if (target === undefined) return { output, removed };
    const start = target.index;
    const open = output.indexOf("(", start);
    const close = matchingDelimiter(output, open, "(", ")");
    const end = statementEnd(output, close + 1);
    output = `${output.slice(0, lineStart(output, start))}${output.slice(lineEnd(output, end))}`;
    removed += 1;
  }
}

function removeForbiddenSpreads(source) {
  let output = source;
  let removed = 0;
  for (;;) {
    const matches = [...output.matchAll(/\.\.\.\(/gu)];
    const target = matches.find((match) => {
      const open = output.indexOf("(", match.index);
      const close = matchingDelimiter(output, open, "(", ")");
      return forbidden(output.slice(open + 1, close));
    });
    if (target === undefined) return { output, removed };
    const start = target.index;
    const open = output.indexOf("(", start);
    let end = matchingDelimiter(output, open, "(", ")") + 1;
    end = nextCodeIndex(output, end);
    if (output[end] !== ",") throw new Error("unexpected emitted test spread");
    output = `${output.slice(0, lineStart(output, start))}${output.slice(lineEnd(output, end + 1))}`;
    removed += 1;
  }
}

function replaceExactly(source, before, after, expected, label) {
  const count = source.split(before).length - 1;
  if (count !== expected) throw new Error(`unexpected emitted ${label}`);
  return source.split(before).join(after);
}

function assertProductionOnly(source) {
  if (forbidden(source)) throw new Error("connector test control survived production emit");
}

function stripConnector(source) {
  let output = removeNamedBlock(source, "    ", "inspectAdmissionStateForTest");
  output = removeNamedBlock(output, "export async function ", "startConnectorRuntime");
  output = replaceExactly(
    output,
    "options.stallWebhookResponseAfterCommit ?? false",
    "false",
    1,
    "webhook test option",
  );
  output = replaceExactly(
    output,
    'this.options.failPairedStateWriteAfter === "conversation_update"',
    "false",
    1,
    "paired-write test argument",
  );
  output = replaceExactly(
    output,
    'this.options.proveNoProviderDispatch\n                    ? { operation: "complete", outcome: "failed", reason: "provider_start_failed" }\n                    : ',
    "",
    1,
    "provider-dispatch test branch",
  );
  const spreads = removeForbiddenSpreads(output);
  if (spreads.removed !== 5) throw new Error("unexpected emitted connector test spreads");
  const statements = removeForbiddenIfStatements(spreads.output);
  if (statements.removed !== 25) {
    throw new Error(`unexpected emitted connector test branches: ${statements.removed}`);
  }
  assertProductionOnly(statements.output);
  return statements.output;
}

function stripState(source) {
  let output = replaceExactly(
    source,
    "    #deferStorageBoundaryForTest = false;\n",
    "",
    1,
    "deferred boundary field",
  );
  output = removeNamedBlock(output, "    ", "runSeedTransactionForTest");
  output = replaceExactly(
    output,
    "        if (!this.#deferStorageBoundaryForTest)\n            this.#checkStorageBoundary();",
    "        this.#checkStorageBoundary();",
    1,
    "deferred boundary branch",
  );
  for (const name of [
    "initializeConnectorStateForTest",
    "inspectConnectorStateForTest",
    "seedConnectorConversationsForTest",
    "retireConnectorStateForTest",
  ]) {
    const prefix =
      name !== "inspectConnectorStateForTest" ? "export async function " : "export function ";
    output = removeNamedBlock(output, prefix, name);
  }
  output = replaceExactly(
    output,
    ", options.stateActionObserverForTest",
    "",
    1,
    "state observer test argument",
  );
  const statements = removeForbiddenIfStatements(output);
  if (statements.removed !== 1) throw new Error("unexpected emitted state test branches");
  assertProductionOnly(statements.output);
  return statements.output;
}

async function strip(path, transform) {
  const source = await readFile(path, "utf8");
  const output = transform(source);
  await writeFile(path, output, { encoding: "utf8", mode: 0o600 });
}

const [buildRoot, ...rest] = process.argv.slice(2);
if (buildRoot === undefined || rest.length !== 0) throw new Error("invalid connector build root");
await strip(join(buildRoot, "connector-core", "src", "connector.js"), stripConnector);
await strip(join(buildRoot, "connector-core", "src", "state.js"), stripState);
