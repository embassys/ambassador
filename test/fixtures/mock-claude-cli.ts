import { appendFile } from "node:fs/promises";

const scenario = process.argv[2] ?? "success";
const logPath = process.argv[3];
const args = process.argv.slice(4);
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = Buffer.concat(chunks).toString("utf8");

if (logPath !== undefined) {
  await appendFile(logPath, `${JSON.stringify({ args, input })}\n`, "utf8");
}

if (args.join(" ") === "auth status") {
  process.stdout.write(
    `${JSON.stringify({
      loggedIn: scenario !== "signed-out",
      authMethod: scenario === "signed-out" ? "none" : "claude.ai",
    })}\n`,
  );
  process.exitCode = 0;
} else if (scenario === "prompt-failure") {
  process.stderr.write("private provider failure details\n");
  process.exitCode = 17;
} else {
  process.stdout.write(
    `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" })}\n`,
  );
  process.exitCode = 0;
}
