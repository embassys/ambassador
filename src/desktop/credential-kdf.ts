import { fork } from "node:child_process";

let tail: Promise<unknown> = Promise.resolve();
let queued = 0;
/** A short-lived child releases the KDF's native allocation after each derivation. */
export function deriveCredentialKeyIsolated(key: Buffer, salt: Buffer): Promise<Buffer> {
  if (key.length !== 24 || salt.length !== 16 || queued >= 8)
    return Promise.reject(new Error("Encryption key derivation is unavailable."));
  queued++;
  const result = tail.then(() => derive(key, salt));
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result.finally(() => {
    queued--;
  });
}

function derive(key: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const environment: NodeJS.ProcessEnv = {};
    for (const name of ["SystemRoot", "TEMP", "TMP", "TMPDIR", "WINDIR"])
      if (process.env[name]) environment[name] = process.env[name];
    const childOptions = {
      execPath: process.execPath,
      execArgv: [],
      env: environment,
      stdio: ["ignore", "ignore", "ignore", "ipc"] as ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced" as const,
      windowsHide: true,
    };
    const child = fork(new URL("./credential-kdf-worker.js", import.meta.url), [], childOptions);
    let derived: Buffer | undefined;
    let failed = false;
    let settled = false;
    const fail = () => {
      failed = true;
      derived?.fill(0);
      child.kill("SIGKILL");
    };
    const timer = setTimeout(fail, 15_000);
    child.once("message", (value: unknown) => {
      if (
        !value ||
        typeof value !== "object" ||
        Object.keys(value).length !== 1 ||
        !("key" in value) ||
        !Buffer.isBuffer(value.key) ||
        value.key.length !== 32
      ) {
        fail();
        return;
      }
      derived = Buffer.from(value.key);
      value.key.fill(0);
    });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failed || code !== 0 || !derived) {
        derived?.fill(0);
        reject(new Error("Encryption key derivation failed."));
      } else resolve(derived);
    };
    child.once("exit", finish);
    child.once("error", () => {
      fail();
      finish(null);
    });
    child.send({ key, salt }, (error) => {
      if (error) fail();
    });
  });
}
