#!/usr/bin/env node

import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CX04_CONFIRMATION,
  executeSystemQualification,
  runCx04Qualification,
} from "./cx04-qualification-lib.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const requiredConfirmation = "run-authenticated-codex-0.149.0-on-disposable-account";
if (requiredConfirmation !== CX04_CONFIRMATION) throw new Error("CX04 confirmation drift");

const exitCode = await runCx04Qualification(process.argv.slice(2), {
  async execute() {
    return await executeSystemQualification({
      repositoryRoot,
      temporaryParent: tmpdir(),
      pnpmExecutable: "pnpm",
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
