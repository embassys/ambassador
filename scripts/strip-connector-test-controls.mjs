import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const forbiddenControls = [
  "afterVersionProbeForTest",
  "beforeFaultForTest",
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
  "fixtureExecutablePath",
  "proveNoProviderDispatch",
  "providerDispatchDelayMsForTest",
  "processBarrierForTest",
  "processGroupProbeForTest",
  "processObserverForTest",
  "spawnMonitorForTest",
  "stallWebhookResponseAfterCommit",
  "stateActionObserverForTest",
  "uuidForTest",
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

function replaceNamedBlock(source, prefix, name, replacement) {
  const marker = `${prefix}${name}(`;
  const start = source.indexOf(marker);
  if (start === -1 || source.indexOf(marker, start + 1) !== -1) {
    throw new Error(`unexpected emitted block ${name}`);
  }
  const bodyStart = source.indexOf("{", start + marker.length);
  if (bodyStart === -1) throw new Error(`missing emitted block body ${name}`);
  const bodyEnd = matchingDelimiter(source, bodyStart, "{", "}") + 1;
  return `${source.slice(0, lineStart(source, start))}${replacement}${source.slice(lineEnd(source, bodyEnd))}`;
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
  if (statements.removed !== 29) {
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

function stripCodexAppServerAdapter(source) {
  let output = replaceExactly(
    source,
    "options.clock ?? SYSTEM_CLOCK",
    "SYSTEM_CLOCK",
    2,
    "Codex adapter test clocks",
  );
  output = replaceExactly(
    output,
    "options.fixtureExecutablePath",
    "undefined",
    1,
    "Codex adapter fixture executable",
  );
  output = replaceExactly(
    output,
    `        const spawnAppServer = this.options.spawnAppServerForTest ??
            ((executable, arguments_, options) => spawn(executable, [...arguments_], {
                cwd: options.cwd,
                env: { ...options.env },
                detached: options.detached,
                shell: options.shell,
                stdio: [...options.stdio],
                windowsHide: true,
            }));`,
    `        const spawnAppServer = (executable, arguments_, options) => spawn(executable, [...arguments_], {
            cwd: options.cwd,
            env: { ...options.env },
            detached: options.detached,
            shell: options.shell,
            stdio: [...options.stdio],
            windowsHide: true,
        });`,
    1,
    "Codex adapter fixture spawn",
  );
  output = replaceNamedBlock(
    output,
    "    async ",
    "#unitEmpty",
    `    async #unitEmpty(invocation) {
        return (invocation.transport.isClosed() &&
            ownedUnitEmpty(invocation.transport.child, invocation.processGroupId));
    }
`,
  );
  output = replaceNamedBlock(
    output,
    "    async ",
    "#containAndProve",
    `    async #containAndProve(invocation, deadlineMs) {
        if (await this.#unitEmpty(invocation))
            return true;
        if (this.#clock.nowMs() >= deadlineMs)
            return false;
        this.#containmentAttempts += 1;
        const contained = await stopOwnedUnit(invocation.transport.child, invocation.processGroupId, this.#clock, deadlineMs);
        if (contained && (await this.#unitEmpty(invocation)))
            return true;
        const cleanupWait = { cancelled: false };
        const remaining = await waitBounded(this.#clock, this.#waitForUnitEmpty(invocation, cleanupWait), Math.max(0, deadlineMs - this.#clock.nowMs()));
        cleanupWait.cancelled = true;
        return !remaining.timedOut && remaining.value;
    }
`,
  );
  output = removeNamedBlock(output, "export async function ", "createCodexAppServerAdapterForTest");
  const statements = removeForbiddenIfStatements(output);
  if (statements.removed !== 1) {
    throw new Error(`unexpected emitted Codex adapter test branches: ${statements.removed}`);
  }
  assertProductionOnly(statements.output);
  return statements.output;
}

function stripClaudeCodeAdapter(source) {
  let output = replaceExactly(
    source,
    "options.clock ?? SYSTEM_CLOCK",
    "SYSTEM_CLOCK",
    1,
    "Claude adapter test clock",
  );
  output = replaceExactly(
    output,
    "this.options.clock !== undefined",
    "false",
    1,
    "Claude adapter test-clock branch",
  );
  output = replaceExactly(
    output,
    `        this.#spawnMonitor =
            options.spawnMonitorForTest ??
                ((executable, arguments_, spawnOptions) => spawn(executable, [...arguments_], {
                    cwd: spawnOptions.cwd,
                    env: { ...spawnOptions.env },
                    detached: spawnOptions.detached,
                    shell: spawnOptions.shell,
                    stdio: [...spawnOptions.stdio],
                    windowsHide: true,
                }));`,
    `        this.#spawnMonitor = (executable, arguments_, spawnOptions) => spawn(executable, [...arguments_], {
            cwd: spawnOptions.cwd,
            env: { ...spawnOptions.env },
            detached: spawnOptions.detached,
            shell: spawnOptions.shell,
            stdio: [...spawnOptions.stdio],
            windowsHide: true,
        });`,
    1,
    "Claude adapter fixture spawn",
  );
  output = replaceNamedBlock(
    output,
    "    async ",
    "#nextUntil",
    `    async #nextUntil(invocation, deadlineUnixMs, _realFallbackMs) {
        const waiting = invocation.queue.wait();
        const delayMs = Math.max(0, deadlineUnixMs - this.#clock.nowMs());
        const clockTimer = timerPromise(this.#clock, delayMs);
        const timeout = Symbol("timeout");
        const result = await Promise.race([
            waiting.promise,
            clockTimer.promise.then(() => timeout),
        ]);
        clockTimer.cancel();
        if (result === timeout) {
            waiting.cancel();
            throw new DeadlineFailure();
        }
        return result;
    }
`,
  );
  output = replaceNamedBlock(
    output,
    "    ",
    "#uuid",
    `    #uuid(_kind) {
        const value = randomUUID();
        if (!SESSION_ID.test(value))
            throw new ProtocolFailure();
        return value;
    }
`,
  );
  output = replaceNamedBlock(
    output,
    "    async ",
    "#barrier",
    `    async #barrier(_scope, _barrier) {
    }
`,
  );
  output = replaceNamedBlock(
    output,
    "    ",
    "#observe",
    `    #observe(_scope, _observation) {
    }
`,
  );
  output = replaceExactly(
    output,
    "resolveExecutable(options.fixtureExecutablePath, environment)",
    "resolveExecutable(undefined, environment)",
    1,
    "Claude adapter fixture executable",
  );
  output = replaceExactly(
    output,
    `await executableIdentity(canonicalExecutable, options.fixtureExecutablePath === undefined
            ? canonicalExecutable
            : (executable ?? canonicalExecutable))`,
    "await executableIdentity(canonicalExecutable, canonicalExecutable)",
    1,
    "Claude adapter fixture launch path",
  );
  output = removeNamedBlock(output, "export async function ", "createClaudeCodeAdapterForTest");
  output = replaceNamedBlock(
    output,
    "    ",
    "#groupProbe",
    `    #groupProbe(pgid) {
        return processGroupProbe(pgid);
    }
`,
  );
  const statements = removeForbiddenIfStatements(output);
  if (statements.removed !== 1) {
    throw new Error(`unexpected emitted Claude adapter test branches: ${statements.removed}`);
  }
  assertProductionOnly(statements.output);
  return statements.output;
}

function stripClaudeLifetimeMonitor(source) {
  let output = removeNamedBlock(
    source,
    "export async function ",
    "runClaudeLifetimeMonitorForTest",
  );
  output = replaceExactly(
    output,
    "class InjectedMonitorFault extends Error {\n}\n",
    "",
    1,
    "Claude monitor injected-fault class",
  );
  output = replaceExactly(
    output,
    "async function runMonitor(faultInjection) {",
    "async function runMonitor() {",
    1,
    "Claude monitor fault argument",
  );
  output = replaceExactly(
    output,
    `    const atBarrier = async (barrier) => {
        if (faultInjection?.barrier !== barrier)
            return;
        await faultInjection.beforeFault?.();
        if (faultInjection.faultAfterBarrier)
            throw new InjectedMonitorFault();
    };
`,
    "",
    1,
    "Claude monitor fault barrier",
  );
  output = replaceExactly(
    output,
    `        await atBarrier("during_start_record");
`,
    "",
    1,
    "Claude monitor start-record barrier",
  );
  output = replaceExactly(
    output,
    `        await atBarrier("before_claude_spawn");
`,
    "",
    1,
    "Claude monitor before-spawn barrier",
  );
  output = replaceExactly(
    output,
    `        await atBarrier("after_claude_spawn");
`,
    "",
    1,
    "Claude monitor after-spawn barrier",
  );
  output = replaceExactly(
    output,
    `        await atBarrier("before_child_started");
`,
    "",
    1,
    "Claude monitor child-started barrier",
  );
  output = replaceExactly(
    output,
    `        await atBarrier("before_monitor_ready");
`,
    "",
    1,
    "Claude monitor ready barrier",
  );
  output = replaceExactly(
    output,
    `    catch (error) {
        fault(error instanceof InjectedMonitorFault ? "internal_failure" : "internal_failure");
    }`,
    `    catch {
        fault("internal_failure");
    }`,
    1,
    "Claude monitor ready fault mapping",
  );
  output = replaceExactly(
    output,
    `            fault(error instanceof InjectedMonitorFault ? "internal_failure" : "invalid_control");`,
    `            fault("invalid_control");`,
    1,
    "Claude monitor control fault mapping",
  );
  assertProductionOnly(output);
  return output;
}

async function strip(path, transform) {
  const source = await readFile(path, "utf8");
  const output = transform(source);
  await writeFile(path, output, { encoding: "utf8", mode: 0o600 });
}

const [buildRoot, provider, ...rest] = process.argv.slice(2);
if (
  buildRoot === undefined ||
  !["codex", "claude", "gemini"].includes(provider ?? "") ||
  rest.length !== 0
) {
  throw new Error("invalid connector build root");
}
await strip(join(buildRoot, "connector-core", "src", "connector.js"), stripConnector);
await strip(join(buildRoot, "connector-core", "src", "state.js"), stripState);
if (provider === "codex") {
  await strip(
    join(buildRoot, "codex-connector", "src", "app-server-adapter.js"),
    stripCodexAppServerAdapter,
  );
}
if (provider === "claude") {
  await strip(
    join(buildRoot, "claude-connector", "src", "claude-code-adapter.js"),
    stripClaudeCodeAdapter,
  );
  await strip(
    join(buildRoot, "claude-connector", "src", "claude-lifetime-monitor.js"),
    stripClaudeLifetimeMonitor,
  );
}
