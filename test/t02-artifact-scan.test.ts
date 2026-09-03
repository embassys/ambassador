import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

interface ScanResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface ScanManifest {
  roots: string[];
  captures: Array<{ name: string; value: string; truncated?: boolean }>;
  markers: Array<{ name: string; encoding: "utf8" | "base64"; value: string }>;
  limits?: Partial<{
    maxFiles: number;
    maxFileBytes: number;
    maxTotalFileBytes: number;
    maxCaptureBytes: number;
    maxTotalCaptureBytes: number;
    maxDepth: number;
  }>;
}

const SCANNER = join(process.cwd(), "scripts", "t02-artifact-scan.mjs");
const SAFE_MARKER = "known-secret-marker-7db2a759";

async function artifactRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "a2a-t02-artifact-scan-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

async function runScanner(manifest: ScanManifest): Promise<ScanResult> {
  const child = spawn(process.execPath, [SCANNER], {
    cwd: process.cwd(),
    env: {
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
      ...(process.env.ComSpec === undefined ? {} : { ComSpec: process.env.ComSpec }),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    if (stdout.length > 65_536) child.kill();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 65_536) child.kill();
  });
  child.stdin.end(JSON.stringify(manifest));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, stdout, stderr };
}

test("treats Windows paths on different drives as disjoint", async () => {
  const scannerModule = (await import(pathToFileURL(SCANNER).href)) as {
    isWithinPath: (
      candidate: string,
      parent: string,
      pathApi: Pick<typeof win32, "isAbsolute" | "relative" | "sep">,
    ) => boolean;
  };
  const artifactRoot = String.raw`C:\Users\runneradmin\AppData\Local\Temp\a2a-artifacts`;
  const repositoryRoot = String.raw`D:\a\a2a\a2a`;

  assert.equal(scannerModule.isWithinPath(artifactRoot, repositoryRoot, win32), false);
  assert.equal(scannerModule.isWithinPath(repositoryRoot, artifactRoot, win32), false);
  assert.equal(
    scannerModule.isWithinPath(String.raw`D:\a\a2a\a2a\state`, repositoryRoot, win32),
    true,
  );
});

test("scans bounded process files and in-memory transcript captures without exposing markers", async (t) => {
  const root = await artifactRoot(t);
  await mkdir(join(root, "state", "nested"), { recursive: true });
  await writeFile(join(root, "state", "journal.sqlite"), Buffer.from([0, 1, 2, 3, 4, 5]));
  await writeFile(join(root, "state", "nested", "gateway.log"), "content-blind event\n");

  const result = await runScanner({
    roots: [root],
    captures: [
      {
        name: "stdout",
        value: "MCP endpoint: http://127.0.0.1:8787/mcp\n",
        truncated: false,
      },
      { name: "stderr", value: "" },
    ],
    markers: [{ name: "access-token", encoding: "utf8", value: SAFE_MARKER }],
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /^artifact scan passed: 2 files, 26 file bytes, 2 captures,/u);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes(SAFE_MARKER), false);
  assert.equal(result.stdout.includes(root), false);
});

const FORBIDDEN_CASES = [
  {
    name: "access-token",
    encoding: "utf8" as const,
    value: "eyJhbGciOiJFUzI1NiJ9.fixture-access-token.signature",
  },
  {
    name: "private-key",
    encoding: "base64" as const,
    value: Buffer.from("fixture-private-pkcs8-der-material").toString("base64"),
  },
  {
    name: "dpop-proof",
    encoding: "utf8" as const,
    value: "eyJ0eXAiOiJkcG9wK2p3dCJ9.fixture-proof.signature",
  },
  {
    name: "dpop-nonce",
    encoding: "utf8" as const,
    value: "A".repeat(76),
  },
  { name: "verification-code", encoding: "utf8" as const, value: "761932" },
  {
    name: "message-text",
    encoding: "utf8" as const,
    value: "fixture message text must remain process-only 8a1272",
  },
  {
    name: "reply-tool-text",
    encoding: "utf8" as const,
    value: "fixture reply and tool text must remain process-only 07f36a",
  },
  {
    name: "idempotency-key",
    encoding: "utf8" as const,
    value: "8fdaf036-a592-4758-aae8-4db88c069d3b",
  },
] as const;

for (const forbidden of FORBIDDEN_CASES) {
  test(`rejects ${forbidden.name} in files without echoing its value or path`, async (t) => {
    const root = await artifactRoot(t);
    const decoded =
      forbidden.encoding === "base64"
        ? Buffer.from(forbidden.value, "base64")
        : Buffer.from(forbidden.value, "utf8");
    await writeFile(
      join(root, "artifact.bin"),
      Buffer.concat([Buffer.from("safe-prefix:"), decoded]),
    );
    const result = await runScanner({
      roots: [root],
      captures: [],
      markers: [forbidden],
    });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      new RegExp(`forbidden ${forbidden.name} found in artifact-root-1-file-1`, "u"),
    );
    assert.equal(result.stderr.includes(forbidden.value), false);
    assert.equal(result.stderr.includes(decoded.toString("utf8")), false);
    assert.equal(result.stderr.includes(root), false);
    assert.equal(result.stderr.includes("artifact.bin"), false);
  });
}

test("rejects forbidden values in captured stdout and stderr", async () => {
  const result = await runScanner({
    roots: [],
    captures: [{ name: "stderr", value: `safe prefix ${SAFE_MARKER} safe suffix` }],
    markers: [{ name: "reissue-token", encoding: "utf8", value: SAFE_MARKER }],
  });

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "forbidden reissue-token found in capture-stderr\n");
  assert.equal(result.stderr.includes(SAFE_MARKER), false);
});

test("fails closed when a forbidden marker fell out of a truncated capture tail", async () => {
  const completeOutput = `${SAFE_MARKER}${"safe retained output ".repeat(16)}`;
  const retainedTail = completeOutput.slice(-64);
  assert.equal(retainedTail.includes(SAFE_MARKER), false);

  const result = await runScanner({
    roots: [],
    captures: [{ name: "stdout", value: retainedTail, truncated: true }],
    markers: [{ name: "access-token", encoding: "utf8", value: SAFE_MARKER }],
  });

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "artifact scan configuration failed: capture-stdout is truncated\n");
  assert.equal(result.stderr.includes(SAFE_MARKER), false);
  assert.equal(result.stderr.includes(retainedTail), false);
});

test("fails closed at configurable file, total-byte, and depth bounds", async (t) => {
  const root = await artifactRoot(t);
  await writeFile(join(root, "one"), "12345678");
  await writeFile(join(root, "two"), "abcdefgh");
  const marker = [{ name: "access-token", encoding: "utf8" as const, value: SAFE_MARKER }];

  const fileCount = await runScanner({
    roots: [root],
    captures: [],
    markers: marker,
    limits: { maxFiles: 1 },
  });
  assert.equal(fileCount.code, 2);
  assert.match(fileCount.stderr, /file-count limit/u);

  const fileBytes = await runScanner({
    roots: [root],
    captures: [],
    markers: marker,
    limits: { maxFileBytes: 7 },
  });
  assert.equal(fileBytes.code, 2);
  assert.match(fileBytes.stderr, /file exceeds/u);

  const totalBytes = await runScanner({
    roots: [root],
    captures: [],
    markers: marker,
    limits: { maxTotalFileBytes: 15 },
  });
  assert.equal(totalBytes.code, 2);
  assert.match(totalBytes.stderr, /total-byte limit/u);

  const nestedRoot = await artifactRoot(t);
  await mkdir(join(nestedRoot, "one", "two"), { recursive: true });
  await writeFile(join(nestedRoot, "one", "two", "artifact"), "safe");
  const depth = await runScanner({
    roots: [nestedRoot],
    captures: [],
    markers: marker,
    limits: { maxDepth: 1 },
  });
  assert.equal(depth.code, 2);
  assert.match(depth.stderr, /depth limit/u);
});

test("fails closed at the configurable capture byte bound", async () => {
  const result = await runScanner({
    roots: [],
    captures: [{ name: "stderr", value: "12345678" }],
    markers: [{ name: "access-token", encoding: "utf8", value: SAFE_MARKER }],
    limits: { maxCaptureBytes: 7 },
  });

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "artifact scan configuration failed: capture exceeds the configured byte limit\n",
  );
  assert.equal(result.stderr.includes(SAFE_MARKER), false);
});

test("rejects roots inside the source tree without echoing their paths", async () => {
  const result = await runScanner({
    roots: [process.cwd()],
    captures: [],
    markers: [{ name: "fixture-vector", encoding: "utf8", value: SAFE_MARKER }],
  });
  assert.equal(result.code, 2);
  assert.equal(
    result.stderr,
    "artifact scan configuration failed: artifact roots must not overlap the repository source tree\n",
  );
  assert.equal(result.stderr.includes(process.cwd()), false);
});

test("rejects roots containing the source tree without echoing their paths", async () => {
  const containingRoot = dirname(process.cwd());
  const result = await runScanner({
    roots: [containingRoot],
    captures: [],
    markers: [{ name: "fixture-vector", encoding: "utf8", value: SAFE_MARKER }],
  });
  assert.equal(result.code, 2);
  assert.equal(
    result.stderr,
    "artifact scan configuration failed: artifact roots must not overlap the repository source tree\n",
  );
  assert.equal(result.stderr.includes(containingRoot), false);
  assert.equal(result.stderr.includes(process.cwd()), false);
});

test("rejects directory symbolic links instead of following them outside an artifact root", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await artifactRoot(t);
  const external = await artifactRoot(t);
  await writeFile(join(external, "secret"), SAFE_MARKER);
  await symlink(external, join(root, "linked"));
  const result = await runScanner({
    roots: [root],
    captures: [],
    markers: [{ name: "access-token", encoding: "utf8", value: SAFE_MARKER }],
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /symbolic links/u);
  assert.equal(result.stderr.includes(external), false);
});

test("rejects file symbolic links instead of opening their targets", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await artifactRoot(t);
  const external = await artifactRoot(t);
  const externalFile = join(external, "secret");
  await writeFile(externalFile, SAFE_MARKER);
  await symlink(externalFile, join(root, "linked-file"));
  const result = await runScanner({
    roots: [root],
    captures: [],
    markers: [{ name: "access-token", encoding: "utf8", value: SAFE_MARKER }],
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /symbolic links/u);
  assert.equal(result.stderr.includes(external), false);
  assert.equal(result.stderr.includes(externalFile), false);
});
