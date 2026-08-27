import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { type CliContext, runCli } from "../../src/cli.js";

interface TestOverrides {
  centralApiUrl: string;
  centralMcpUrl: string;
  stateRoot: string;
  credentialStore?: {
    load: () => Promise<string | undefined>;
    save: (token: string) => Promise<void>;
  };
}

interface RunningGateway {
  endpoint: string;
  artifactRoot: string;
  stateRoot: string;
  stdout: () => string;
  stderr: () => string;
  waitForExit: () => Promise<number>;
  stop: () => Promise<number>;
}

function waitForReady(ready: Promise<string>, completion: Promise<number>): Promise<string> {
  return Promise.race([
    ready,
    completion.then((exitCode) => {
      throw new Error(`gateway exited before startup with code ${exitCode}`);
    }),
    delay(5_000, undefined, { ref: false }).then(() => {
      throw new Error("timed out waiting for gateway startup");
    }),
  ]);
}

export async function startGateway(
  t: TestContext,
  options: {
    webhookUrl: string;
    webhookToken: string;
    centralApiUrl: string;
    centralMcpUrl: string;
    artifactRoot?: string;
    credentialStore?: TestOverrides["credentialStore"];
    verbose?: boolean;
  },
): Promise<RunningGateway> {
  const directory =
    options.artifactRoot ?? (await mkdtemp(join(tmpdir(), "a2a-single-gateway-test-")));
  if (options.artifactRoot === undefined) {
    t.after(() => rm(directory, { force: true, recursive: true }));
  }
  const controller = new AbortController();
  const stateRoot = join(directory, "state", "a2a-gateway");
  let stdout = "";
  let stderr = "";
  let resolveReady: ((endpoint: string) => void) | undefined;
  const ready = new Promise<string>((resolve) => {
    resolveReady = resolve;
  });
  const context: CliContext & { testOverrides: TestOverrides } = {
    cwd: directory,
    env: {
      HOME: directory,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_STATE_HOME: join(directory, "state"),
      A2A_WEBHOOK_TOKEN: options.webhookToken,
    },
    signal: controller.signal,
    io: {
      stdout: {
        write(chunk: string | Uint8Array): boolean {
          stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
          const match = /^MCP endpoint: (http:\/\/127\.0\.0\.1:8787\/mcp)$/mu.exec(stdout);
          if (match?.[1] !== undefined) {
            resolveReady?.(match[1]);
            resolveReady = undefined;
          }
          return true;
        },
      },
      stderr: {
        write(chunk: string | Uint8Array): boolean {
          stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
          return true;
        },
      },
    },
    testOverrides: {
      centralApiUrl: options.centralApiUrl,
      centralMcpUrl: options.centralMcpUrl,
      stateRoot,
      ...(options.credentialStore === undefined
        ? {}
        : { credentialStore: options.credentialStore }),
    },
  };

  const completion = runCli(
    [
      "start",
      `--webhook-url=${options.webhookUrl}`,
      "--webhook-token-env=A2A_WEBHOOK_TOKEN",
      ...(options.verbose === true ? ["--verbose=true"] : []),
    ],
    context,
  );
  let stopped: Promise<number> | undefined;
  const stop = async (): Promise<number> => {
    controller.abort();
    stopped ??= completion;
    return await stopped;
  };
  t.after(stop);
  const endpoint = await waitForReady(ready, completion);

  return {
    endpoint,
    artifactRoot: directory,
    stateRoot,
    stdout: () => stdout,
    stderr: () => stderr,
    waitForExit: async () => await completion,
    stop,
  };
}
