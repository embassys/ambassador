import { spawn } from "node:child_process";
import { appendFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { reviewedRedInventory } from "./red-inventory-manifest.mjs";

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const STOP_TIMEOUT_MS = 2_000;

const definitions = {
  t03: {
    key: "t03",
    label: "T03 REST enrollment and DPoP",
    filePrefix: "t03-",
    files: [
      "t03-artifact-lifecycle.test.js",
      "t03-dpop-transport-negatives.test.js",
      "t03-issuance-negatives.test.js",
      "t03-publication-crash.test.js",
      "t03-reissue-lifecycle.test.js",
      "t03-rest-boundaries.test.js",
      "t03-rest-dpop-gateway.test.js",
      "t03-security-lifecycle.test.js",
      "t03-size-boundaries.test.js",
    ],
    expected: { tests: 139, pass: 105, fail: 34, skipped: 0, todo: 0 },
    timeoutMs: 90_000,
    vectorNote:
      "129 behavior vectors: 31 expected red, 98 current green (19 G01 credential checks, 78 newly green G02 enrollment checks, and 1 shipped closed-schema guard)",
  },
  t04: {
    key: "t04",
    label: "T04 conversation recovery",
    filePrefix: "t04-",
    files: [
      "t04-commit-recovery.test.js",
      "t04-conversation-recovery.test.js",
      "t04-crash-barriers.test.js",
      "t04-inbound-boundaries.test.js",
      "t04-lifecycle-contract.test.js",
      "t04-outbound-boundaries.test.js",
      "t04-response-observer.test.js",
    ],
    expected: { tests: 41, pass: 1, fail: 40, skipped: 0, todo: 0 },
    timeoutMs: 120_000,
    vectorNote: "41 behavior checks: 40 expected red, 1 response-observer support check green",
  },
  "packaged-docker": {
    key: "packaged-docker",
    label: "Packaged gateway and independent Docker v2 fixture",
    exactFile: "c01-packaged-docker-v2.test.js",
    files: ["c01-packaged-docker-v2.test.js"],
    expected: { tests: 1, pass: 0, fail: 1, skipped: 0, todo: 0 },
    timeoutMs: 60_000,
    vectorNote: "1 future-v2 packaged smoke check: 1 expected red",
  },
};

const requested = process.argv.slice(2);
let selected;
if (requested.length === 0) {
  selected = [definitions.t03, definitions.t04];
} else if (requested.length === 1 && requested[0] === "--suite=packaged-docker") {
  selected = [definitions["packaged-docker"]];
} else {
  throw new Error("Usage: node scripts/run-red-inventory.mjs [--suite=packaged-docker]");
}

const root = join(process.cwd(), ".test-dist", "test");
const entries = await readdir(root, { recursive: true, withFileTypes: true });
const compiledTests = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
  .map((entry) => join(entry.parentPath, entry.name))
  .sort();

function suiteFiles(definition) {
  const matches = compiledTests.filter((file) => {
    const name = basename(file);
    return definition.exactFile === undefined
      ? name.startsWith(definition.filePrefix)
      : name === definition.exactFile;
  });
  const names = matches.map((file) => basename(file));
  if (JSON.stringify(names) !== JSON.stringify(definition.files)) {
    throw new Error(
      `${definition.label} file inventory changed: expected ${definition.files.length}, observed ${names.length}`,
    );
  }
  return matches;
}

function nodeKey(node) {
  return `${node.file}\u0000${node.nesting}\u0000${node.name}`;
}

function parseEvents(output, definition) {
  return output
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw new Error(`${definition.label} emitted malformed structured reporter output`);
      }
      if (
        !["fail", "pass"].includes(event.status) ||
        typeof event.name !== "string" ||
        typeof event.file !== "string" ||
        !Number.isSafeInteger(event.nesting) ||
        typeof event.skip !== "boolean" ||
        typeof event.todo !== "boolean" ||
        !Array.isArray(event.infrastructure)
      ) {
        throw new Error(`${definition.label} emitted an invalid structured reporter event`);
      }
      return event;
    });
}

function classifyEvents(events, definition) {
  const expected = reviewedRedInventory[definition.key];
  if (events.some((event) => event.infrastructure.length !== 0)) {
    throw new Error(`${definition.label} hit a classified infrastructure failure`);
  }
  if (events.length !== expected.length) {
    throw new Error(
      `${definition.label} node inventory changed: expected ${expected.length}, observed ${events.length}`,
    );
  }
  const observedByKey = new Map();
  for (const event of events) {
    if (observedByKey.has(nodeKey(event))) {
      throw new Error(`${definition.label} emitted a duplicate reviewed node identity`);
    }
    observedByKey.set(nodeKey(event), event);
  }
  for (const reviewed of expected) {
    const observed = observedByKey.get(nodeKey(reviewed));
    if (observed === undefined) {
      throw new Error(`${definition.label} exact reviewed node inventory changed`);
    }
    if (observed.status !== reviewed.status) {
      throw new Error(`${definition.label} exact reviewed node status changed`);
    }
    if (observed.skip !== reviewed.skip || observed.todo !== reviewed.todo) {
      throw new Error(`${definition.label} exact reviewed node directive changed`);
    }
    if (reviewed.status === "fail") {
      const boundary = definition.key === "packaged-docker" ? observed.marker : observed.signature;
      if (boundary !== reviewed.boundary) {
        throw new Error(`${definition.label} advanced beyond a reviewed failure boundary`);
      }
    }
  }
  const observed = {
    tests: events.length,
    pass: events.filter((event) => event.status === "pass" && !event.skip && !event.todo).length,
    fail: events.filter((event) => event.status === "fail" && !event.todo).length,
    skipped: events.filter((event) => event.skip).length,
    todo: events.filter((event) => event.todo).length,
  };
  for (const [key, value] of Object.entries(definition.expected)) {
    if (observed[key] !== value) {
      throw new Error(`${definition.label} classified ${key} count changed`);
    }
  }
  return observed;
}

async function withTimeout(operation, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    timer.unref();
  });
  const result = await Promise.race([
    operation.then((value) => ({ timedOut: false, value })),
    timeout,
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

function signalPosixGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function runTaskkill(pid, force) {
  const killer = spawn("taskkill", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  const completion = new Promise((resolve) => {
    killer.once("error", resolve);
    killer.once("close", resolve);
  });
  const result = await withTimeout(completion, STOP_TIMEOUT_MS);
  if (result.timedOut && killer.exitCode === null && killer.signalCode === null) {
    killer.kill("SIGKILL");
  }
}

async function stopProcessTree(child, completion) {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") await runTaskkill(pid, false);
  else signalPosixGroup(pid, "SIGTERM");
  const graceful = await withTimeout(completion, STOP_TIMEOUT_MS);
  if (!graceful.timedOut) return;
  if (process.platform === "win32") await runTaskkill(pid, true);
  else signalPosixGroup(pid, "SIGKILL");
  const forced = await withTimeout(completion, STOP_TIMEOUT_MS);
  if (forced.timedOut) throw new Error("red-suite process tree did not stop within its bound");
}

async function runSuite(definition) {
  const child = spawn(
    process.execPath,
    [
      "--test",
      "--test-concurrency=1",
      "--test-reporter=./scripts/red-inventory-reporter.mjs",
      ...suiteFiles(definition),
    ],
    {
      cwd: process.cwd(),
      detached: process.platform !== "win32",
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let output = "";
  let stderrBytes = 0;
  let captureBytes = 0;
  let overflow = false;
  const capture = (chunk, isStderr) => {
    captureBytes += chunk.byteLength;
    if (isStderr) stderrBytes += chunk.byteLength;
    if (captureBytes > MAX_CAPTURE_BYTES) {
      overflow = true;
    } else if (!isStderr) {
      output += chunk.toString("utf8");
    }
  };
  child.stdout.on("data", (chunk) => capture(chunk, false));
  child.stderr.on("data", (chunk) => capture(chunk, true));
  let exitState;
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      exitState = { code, signal };
    });
    child.once("close", () => {
      if (exitState === undefined) reject(new Error("red-suite process closed without exit state"));
      else resolve(exitState);
    });
  });
  const bounded = await withTimeout(completion, definition.timeoutMs);
  if (bounded.timedOut || overflow) await stopProcessTree(child, completion);
  if (bounded.timedOut) throw new Error(`${definition.label} timed out`);
  if (overflow) throw new Error(`${definition.label} output exceeded the 4 MiB diagnostic bound`);
  if (stderrBytes !== 0) throw new Error(`${definition.label} emitted unexpected stderr output`);
  if (bounded.value.signal !== null || bounded.value.code !== 1) {
    throw new Error(
      `${definition.label} exited unexpectedly: code=${String(bounded.value.code)} signal=${String(bounded.value.signal)}`,
    );
  }
  return { definition, observed: classifyEvents(parseEvents(output, definition), definition) };
}

const results = [];
for (const definition of selected) results.push(await runSuite(definition));

console.log("C01 classified red inventory matched:");
for (const { definition, observed } of results) {
  console.log(
    `- ${definition.label} | ${observed.tests} | ${observed.fail} | ${observed.pass} | ${observed.skipped} | ${observed.todo} | ${definition.vectorNote}`,
  );
}

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath !== undefined && summaryPath !== "") {
  const markdown = [
    "\n## C01 classified red inventory\n",
    "| Suite | Node test nodes | Expected red nodes | Current green nodes | Skipped | Todo | Behavior classification |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...results.map(
      ({ definition, observed }) =>
        `| ${definition.label} | ${observed.tests} | ${observed.fail} | ${observed.pass} | ${observed.skipped} | ${observed.todo} | ${definition.vectorNote} |`,
    ),
    "",
    "These are fixture-backed client specifications. They are not evidence that production central implements the target contract.",
    "",
  ].join("\n");
  await appendFile(summaryPath, markdown, "utf8");
}
