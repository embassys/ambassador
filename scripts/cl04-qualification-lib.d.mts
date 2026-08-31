export const CLAUDE_CODE_VERSION_STDOUT: string;
export const CL04_CONFIRMATION: string;

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

export function runBoundedCommand(
  request: CommandRequest & { timeoutMs?: number; phase?: string },
): Promise<CommandResult>;

export function preparePackedClaudeConnector(
  options: {
    repositoryRoot: string;
    temporaryRoot: string;
    nodeExecutable: string;
    pnpmCli: string;
    pnpmStore: string;
    pnpmCache: string;
    environment: Readonly<Record<string, string>>;
  },
  run: (request: CommandRequest) => Promise<CommandResult>,
): Promise<{ tarball: string; installRoot: string; connectorExecutable: string }>;

export interface QualificationEvidence {
  platform: string;
  nodeVersion: string;
  claudeCodeVersion: string;
  tarballSha256: string;
  checks: {
    packedInstall: boolean;
    exactVersion: boolean;
    sessionBeforeInput: boolean;
    structuredInput: boolean;
    twoTurnResume: boolean;
    safeRestrictedStartup: boolean;
    inRootRead: boolean;
    outOfRootReadDenied: boolean;
    workspaceWritePolicy: boolean;
    outOfRootWriteDenied: boolean;
    networkDenied: boolean;
    approvalDenied: boolean;
    externalProcessTopology: boolean;
    cancellation: boolean;
    timeout: boolean;
    normalExit: boolean;
    heldGroupSealing: boolean;
    connectorHardDeathStartup: boolean;
    connectorHardDeathActive: boolean;
    monitorHardDeathContainment: boolean;
    noBlindReplay: boolean;
    providerHistoryResume: boolean;
    artifactsClean: boolean;
  };
}

export function executeSystemQualification(options: {
  repositoryRoot: string;
  temporaryParent: string;
  environment: Readonly<Record<string, string>>;
}): Promise<QualificationEvidence>;

export function runCl04Qualification(
  arguments_: readonly string[],
  dependencies: {
    execute(): Promise<QualificationEvidence>;
    writeStdout(value: string): void;
    writeStderr(value: string): void;
  },
): Promise<number>;
