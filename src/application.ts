import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { createWakeAdapter } from "./adapters/factory.js";
import type { FetchLike } from "./adapters/types.js";
import { parseConfig, resolveSecret, type SidecarConfig } from "./config.js";
import { HttpControllerClient } from "./controller.js";
import { type DaemonEvent, runDaemon } from "./daemon.js";
import { Journal } from "./journal.js";
import { ProcessLock } from "./process-lock.js";
import { Relay } from "./relay.js";

export interface SidecarApplicationOptions {
  config: SidecarConfig;
  journalPath: string;
  lockPath: string;
  env: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  now?: () => number;
  random?: () => number;
  idGenerator?: () => string;
  onEvent?: (event: DaemonEvent) => void;
}

export class SidecarApplication {
  private closed = false;

  private constructor(
    private readonly relay: Relay,
    private readonly journal: Journal,
    private readonly lock: ProcessLock,
    private readonly now: () => number,
    private readonly onEvent: ((event: DaemonEvent) => void) | undefined,
  ) {}

  static async open(options: SidecarApplicationOptions): Promise<SidecarApplication> {
    const config = parseConfig(options.config);
    const lock = await ProcessLock.acquire(options.lockPath);
    let journal: Journal | undefined;

    try {
      await mkdir(dirname(options.journalPath), { recursive: true, mode: 0o700 });
      journal = new Journal(options.journalPath, options.idGenerator);
      const controller = new HttpControllerClient({
        baseUrl: config.controller.base_url,
        token: resolveSecret(config.controller.token, options.env),
        waitSeconds: config.controller.poll_wait_seconds,
        maxNotifications: config.controller.max_notifications,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      const relay = new Relay({
        config,
        journal,
        controller,
        createAdapter: (agent) =>
          createWakeAdapter(agent, {
            env: options.env,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            ...(options.now === undefined ? {} : { now: options.now }),
          }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.random === undefined ? {} : { random: options.random }),
      });
      return new SidecarApplication(relay, journal, lock, options.now ?? Date.now, options.onEvent);
    } catch (error) {
      journal?.close();
      await lock.release();
      throw error;
    }
  }

  async runOnce(signal: AbortSignal): Promise<void> {
    if (this.closed) throw new Error("Sidecar application is closed");
    await this.relay.runOnce(signal);
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.closed) throw new Error("Sidecar application is closed");
    await runDaemon(
      {
        relay: this.relay,
        journal: this.journal,
        now: this.now,
        ...(this.onEvent === undefined ? {} : { onEvent: this.onEvent }),
      },
      signal,
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.journal.close();
    } finally {
      await this.lock.release();
    }
  }
}
