import { runClaudeCliAcpStdio } from "../../src/claude-cli-acp.js";

const mockCli = process.argv[2];
const scenario = process.argv[3];
const logPath = process.argv[4];
if (mockCli === undefined || scenario === undefined || logPath === undefined) {
  throw new Error("Missing Claude CLI fixture arguments");
}

await runClaudeCliAcpStdio({
  command: process.execPath,
  commandPrefixArguments: [mockCli, scenario, logPath],
  environment: process.env,
});
