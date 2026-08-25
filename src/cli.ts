#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CredentialStore } from "./credential-store.js";
import { GatewayError } from "./errors.js";
import { openGatewayApplication, type RunningGatewayApplication } from "./gateway-application.js";
import {
  GatewayOptionsError,
  type GatewayStartOptions,
  parseGatewayStartOptions,
  resolveWebhookToken,
} from "./gateway-options.js";
import { defaultGatewayPaths, pathsForStateDirectory } from "./gateway-paths.js";
import { ProcessLock } from "./process-lock.js";

export interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface CliTestOverrides {
  centralApiUrl: string;
  centralMcpUrl: string;
  stateRoot: string;
  credentialStore?: CredentialStore;
}

export interface CliContext {
  io: CliIo;
  env: NodeJS.ProcessEnv;
  cwd: string;
  signal?: AbortSignal;
  testOverrides?: CliTestOverrides;
}

interface ProcessSignal {
  signal: AbortSignal;
  close(): void;
}

function processSignal(): ProcessSignal {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  return {
    signal: controller.signal,
    close() {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    },
  };
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolveWait) =>
    signal.addEventListener("abort", () => resolveWait(), { once: true }),
  );
}

function homeDirectory(environment: NodeJS.ProcessEnv): string {
  return environment.HOME || environment.USERPROFILE || homedir();
}

export async function runCli(args: string[], context: CliContext): Promise<number> {
  let parsed: GatewayStartOptions;
  try {
    parsed = parseGatewayStartOptions(args);
  } catch (error) {
    if (error instanceof GatewayOptionsError) {
      context.io.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    context.io.stderr.write("Invalid command or arguments\n");
    return 2;
  }

  const paths =
    context.testOverrides === undefined
      ? defaultGatewayPaths(process.platform, context.env, homeDirectory(context.env))
      : pathsForStateDirectory(context.testOverrides.stateRoot, join);
  let lock: ProcessLock | undefined;
  let application: RunningGatewayApplication | undefined;
  const ownedSignal = context.signal === undefined ? processSignal() : undefined;
  const signal = context.signal ?? ownedSignal?.signal;
  if (signal === undefined) throw new Error("Gateway signal is unavailable");

  try {
    lock = await ProcessLock.acquire(paths.lockPath);
    const webhookToken = resolveWebhookToken(context.env, parsed.webhookTokenEnv);
    application = await openGatewayApplication({
      webhookUrl: parsed.webhookUrl,
      webhookToken,
      journalPath: paths.journalPath,
      credentialPath: paths.credentialPath,
      ...(context.testOverrides === undefined
        ? {}
        : {
            centralApiUrl: context.testOverrides.centralApiUrl,
            centralMcpUrl: context.testOverrides.centralMcpUrl,
            ...(context.testOverrides.credentialStore === undefined
              ? {}
              : { credentialStore: context.testOverrides.credentialStore }),
          }),
    });
    context.io.stdout.write(`MCP endpoint: ${application.endpoint}\n`);
    const failure = await Promise.race([
      waitForAbort(signal).then(() => undefined),
      application.failure,
    ]);
    if (failure !== undefined) throw failure;
    return 0;
  } catch (error) {
    if (error instanceof GatewayOptionsError) {
      context.io.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    if (error instanceof GatewayError) {
      context.io.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    context.io.stderr.write("Gateway local state failed\n");
    return 7;
  } finally {
    await application?.close().catch(() => undefined);
    await lock?.release().catch(() => undefined);
    ownedSignal?.close();
  }
}

function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
  }
}

if (isMainModule()) {
  process.exitCode = await runCli(process.argv.slice(2), {
    io: { stdout: process.stdout, stderr: process.stderr },
    env: process.env,
    cwd: process.cwd(),
  });
}
