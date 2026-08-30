import type { ProviderPort } from "../../../packages/connector-core/src/runtime-types.js";

import { CODEX_FIXTURE_SCHEMA_SHA256, CODEX_FIXTURE_VERSION } from "./types.js";

export interface CodexAdapterForTestOptions {
  readonly workingDirectory: string;
  readonly policy: "read-only" | "workspace-write";
  readonly inheritedEnvironment: Readonly<Record<string, string | undefined>>;
  readonly webhookTokenEnvironmentName: string;
  readonly connectorPackageVersion: string;
  readonly fixtureExecutablePath: string;
}

export interface Cx03ProductionModule {
  readonly CODEX_APP_SERVER_VERSION: typeof CODEX_FIXTURE_VERSION;
  readonly CODEX_APP_SERVER_SCHEMA_SHA256: typeof CODEX_FIXTURE_SCHEMA_SHA256;
  createCodexAppServerAdapterForTest(options: CodexAdapterForTestOptions): Promise<ProviderPort>;
}

export function isExactMissingCx03Entry(error: unknown, moduleUrl: URL): boolean {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown; url?: unknown };
  if (candidate.code !== "ERR_MODULE_NOT_FOUND") return false;
  if (candidate.url === moduleUrl.href) return true;
  if (typeof candidate.message !== "string") return false;
  return (
    candidate.message.startsWith(`Cannot find module '${moduleUrl.pathname}'`) ||
    candidate.message.startsWith(`Cannot find module '${moduleUrl.href}'`)
  );
}

export function validateCx03ProductionModule(loaded: unknown): Cx03ProductionModule {
  if (loaded === null || typeof loaded !== "object") {
    throw new TypeError("CX03 Codex adapter entry loaded a non-module value");
  }
  const module = loaded as Partial<Cx03ProductionModule>;
  if (
    module.CODEX_APP_SERVER_VERSION !== CODEX_FIXTURE_VERSION ||
    module.CODEX_APP_SERVER_SCHEMA_SHA256 !== CODEX_FIXTURE_SCHEMA_SHA256 ||
    typeof module.createCodexAppServerAdapterForTest !== "function"
  ) {
    throw new TypeError("CX03 Codex adapter entry is missing its reviewed exports");
  }
  return module as Cx03ProductionModule;
}

export async function loadCx03Production(caseId: string): Promise<Cx03ProductionModule> {
  const url = new URL(
    "../../../packages/codex-connector/src/app-server-adapter.js",
    import.meta.url,
  );
  let loaded: unknown;
  try {
    loaded = await import(url.href);
  } catch (error) {
    if (!isExactMissingCx03Entry(error, url)) throw error;
    throw new Error(`[${caseId}] CX03 Codex App Server adapter production boundary is absent`);
  }
  return validateCx03ProductionModule(loaded);
}
