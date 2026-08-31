export const CODEX_SCHEMA_SHA256: string;
export const CODEX_VERSION_STDOUT: string;
export const CX04_CONFIRMATION: string;

export interface CommandRequest {
  executable: string;
  arguments: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
}

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export function configFingerprint(
  path: string,
): Promise<{ kind: "absent" } | { kind: "sha256"; value: string }>;

export function preparePackedConnector(
  options: {
    repositoryRoot: string;
    temporaryRoot: string;
    pnpmExecutable: string;
    nodeExecutable: string;
    environment: Readonly<Record<string, string>>;
  },
  run: (request: CommandRequest) => Promise<CommandResult>,
): Promise<{ tarball: string; installRoot: string; connectorExecutable: string }>;

export function verifyCodexInstallation(
  options: {
    executable: string;
    schemaDirectories: readonly [string, string];
    expectedSchemaSha256: string;
    environment: Readonly<Record<string, string>>;
  },
  dependencies: {
    run(request: CommandRequest): Promise<CommandResult>;
    readSchema(path: string): Promise<Buffer>;
  },
): Promise<{ schemaSha256: string }>;

export interface QualificationEvidence {
  platform: string;
  nodeVersion: string;
  codexVersion: string;
  schemaSha256: string;
  tarballSha256: string;
  checks: {
    packedInstall: boolean;
    twoTurnResume: boolean;
    readOnlySandbox: boolean;
    workspaceWriteSandbox: boolean;
    outOfRootDenied: boolean;
    networkDenied: boolean;
    cancellation: boolean;
    hardCrashContainment: boolean;
    exactRecovery: boolean;
    configUnchanged: boolean;
    artifactsClean: boolean;
  };
}

export function runCx04Qualification(
  arguments_: readonly string[],
  dependencies: {
    execute(): Promise<QualificationEvidence>;
    writeStdout(value: string): void;
    writeStderr(value: string): void;
  },
): Promise<number>;
