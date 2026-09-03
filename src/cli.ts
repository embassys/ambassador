#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AmbassadorOptionsError, parseAmbassadorCommand } from "./ambassador-options.js";
import type { CredentialStore } from "./credential-store.js";
import { GatewayError } from "./errors.js";
import {
  type DeliveryTargetContext,
  openGatewayApplication,
  type RunningGatewayApplication,
} from "./gateway-application.js";
import { defaultGatewayPaths, pathsForStateDirectory } from "./gateway-paths.js";
import { clearLocalGatewayState } from "./local-state-cleaner.js";
import type { DeliveryTarget } from "./notification-relay.js";
import { ProcessLock } from "./process-lock.js";
import { EncryptedFileWebhookSecretStore } from "./webhook-secret-store.js";

export interface CliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface CliTestOverrides {
  readonly centralOrigin: string;
  readonly stateRoot: string;
  readonly credentialStore?: CredentialStore;
  readonly centralFetch?: typeof fetch;
  readonly webhookFetch?: typeof fetch;
  readonly deliveryTargetFactory?: (context: DeliveryTargetContext) => DeliveryTarget;
  readonly localMcpPort?: number;
  readonly nowSeconds?: () => number;
}

export interface CliContext {
  readonly io: CliIo;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly testOverrides?: CliTestOverrides;
}

interface ProcessSignal {
  readonly signal: AbortSignal;
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

export function startupGuide(endpoint: string): string {
  const openClaw = JSON.stringify({ url: endpoint, transport: "streamable-http", enabled: true });
  return [
    `MCP endpoint: ${endpoint}`,
    "",
    "Connect an agent in another terminal:",
    `  Codex:      codex mcp add ambassador --url ${endpoint}`,
    `  Claude Code: claude mcp add --transport http --scope user ambassador ${endpoint}`,
    `  Hermes:     hermes mcp add ambassador --url ${endpoint}`,
    `  OpenClaw:   openclaw mcp set ambassador '${openClaw}'`,
    "",
    "Then restart or reload the agent and say: Register me with Embassys using my email.",
    "Keep this Ambassador process running.",
    "",
  ].join("\n");
}

function homeDirectory(environment: NodeJS.ProcessEnv): string {
  return environment.HOME || environment.USERPROFILE || homedir();
}

export async function runCli(args: string[], context: CliContext): Promise<number> {
  let command: ReturnType<typeof parseAmbassadorCommand>;
  try {
    command = parseAmbassadorCommand(args);
  } catch (error) {
    context.io.stderr.write(
      `${error instanceof AmbassadorOptionsError ? error.message : "Invalid command or arguments"}\n`,
    );
    return error instanceof AmbassadorOptionsError ? error.exitCode : 2;
  }

  const paths =
    context.testOverrides === undefined
      ? defaultGatewayPaths(process.platform, context.env, homeDirectory(context.env))
      : pathsForStateDirectory(context.testOverrides.stateRoot, join);
  if (command.command === "webhook-secret") {
    try {
      const store = new EncryptedFileWebhookSecretStore(
        paths.webhookSecretPath,
        paths.webhookSecretKeyPath,
      );
      context.io.stdout.write(`${await store.createOrLoad()}\n`);
      return 0;
    } catch {
      context.io.stderr.write("Ambassador webhook secret failed\n");
      return 7;
    }
  }
  if (command.command === "clean") {
    let lock: ProcessLock | undefined;
    try {
      lock = await ProcessLock.acquire(paths.lockPath);
      await clearLocalGatewayState(paths.stateDirectory, paths.lockPath);
      context.io.stdout.write("Ambassador local state cleared\n");
      return 0;
    } catch (error) {
      if (error instanceof GatewayError) {
        context.io.stderr.write(`${error.message}\n`);
        return error.exitCode;
      }
      context.io.stderr.write("Ambassador local state cleanup failed\n");
      return 7;
    } finally {
      await lock?.release().catch(() => undefined);
    }
  }
  let lock: ProcessLock | undefined;
  let application: RunningGatewayApplication | undefined;
  const ownedSignal = context.signal === undefined ? processSignal() : undefined;
  const signal = context.signal ?? ownedSignal?.signal;
  if (signal === undefined) throw new Error("Ambassador signal is unavailable");

  try {
    lock = await ProcessLock.acquire(paths.lockPath);
    application = await openGatewayApplication({
      journalPath: paths.journalPath,
      credentialPath: paths.credentialPath,
      credentialKeyPath: paths.credentialKeyPath,
      webhookSecretPath: paths.webhookSecretPath,
      webhookSecretKeyPath: paths.webhookSecretKeyPath,
      pendingActionPath: paths.pendingActionPath,
      profilePath: paths.profilePath,
      workingDirectory: context.cwd,
      environment: context.env,
      signal,
      ...(context.testOverrides === undefined
        ? {}
        : {
            centralOrigin: context.testOverrides.centralOrigin,
            ...(context.testOverrides.credentialStore === undefined
              ? {}
              : { credentialStore: context.testOverrides.credentialStore }),
            ...(context.testOverrides.centralFetch === undefined
              ? {}
              : { centralFetch: context.testOverrides.centralFetch }),
            ...(context.testOverrides.webhookFetch === undefined
              ? {}
              : { webhookFetch: context.testOverrides.webhookFetch }),
            ...(context.testOverrides.deliveryTargetFactory === undefined
              ? {}
              : { deliveryTargetFactory: context.testOverrides.deliveryTargetFactory }),
            ...(context.testOverrides.localMcpPort === undefined
              ? {}
              : { localMcpPort: context.testOverrides.localMcpPort }),
            ...(context.testOverrides.nowSeconds === undefined
              ? {}
              : { nowSeconds: context.testOverrides.nowSeconds }),
          }),
    });
    context.io.stdout.write(startupGuide(application.endpoint));
    const failure = await Promise.race([
      waitForAbort(signal).then(() => undefined),
      application.failure,
    ]);
    if (failure !== undefined) throw failure;
    return 0;
  } catch (error) {
    if (signal.aborted) return 0;
    if (error instanceof AmbassadorOptionsError) {
      context.io.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    if (error instanceof GatewayError) {
      context.io.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    context.io.stderr.write(
      "Ambassador could not start. Check that its state directory is writable and that this Node platform is supported\n",
    );
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
