#!/usr/bin/env node

import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CL04_CONFIRMATION,
  executeSystemQualification,
  runCl04Qualification,
} from "./cl04-qualification-lib.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const requiredConfirmation = "run-authenticated-claude-code-2.1.251-on-disposable-account";
if (requiredConfirmation !== CL04_CONFIRMATION) throw new Error("CL04 confirmation drift");

const exitCode = await runCl04Qualification(process.argv.slice(2), {
  async execute() {
    return await executeSystemQualification({
      repositoryRoot,
      temporaryParent: tmpdir(),
      environment: Object.fromEntries(
        Object.entries(process.env).filter((entry) => entry[1] !== undefined),
      ),
    });
  },
  writeStdout(value) {
    process.stdout.write(value);
  },
  writeStderr(value) {
    process.stderr.write(value);
  },
});

process.exitCode = exitCode;
