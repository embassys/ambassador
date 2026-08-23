#!/usr/bin/env node

import { NotImplementedError } from "./errors.js";

export interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface CliContext {
  io: CliIo;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export async function runCli(_args: string[], _context: CliContext): Promise<number> {
  throw new NotImplementedError("runCli");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const exitCode = await runCli(process.argv.slice(2), {
    io: { stdout: process.stdout, stderr: process.stderr },
    env: process.env,
    cwd: process.cwd(),
  });
  process.exitCode = exitCode;
}
