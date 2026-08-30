import { createHash } from "node:crypto";
import { basename } from "node:path";

function reviewedBoundary(error) {
  if (typeof error?.stack !== "string") return undefined;
  for (const line of error.stack.split(/\r?\n/u)) {
    const match = /(?:file:\/\/)?(.+?\.test\.js):(\d+):(\d+)/u.exec(line);
    if (match?.[1] !== undefined) {
      return `${basename(match[1])}:${match[2]}:${match[3]}`;
    }
  }
  return undefined;
}

function portableFailureMessage(error, file) {
  const message = error?.message;
  if (
    file === "t03-publication-crash.test.js" &&
    message === "process barrier child disconnected"
  ) {
    return "expected gateway observation did not occur within its bound";
  }
  return message;
}

function failureSignature(error, file) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        name: error?.name,
        code: error?.code,
        failureType: error?.failureType,
        message: portableFailureMessage(error, file),
        boundary: reviewedBoundary(error),
      }),
    )
    .digest("hex");
}

function reviewedMarker(error) {
  if (typeof error?.message !== "string") return undefined;
  return /^\[([A-Z0-9]+(?:-[A-Za-z0-9]+)*(?::[A-Za-z0-9-]+)?)\]/u.exec(error.message)?.[1];
}

function infrastructureLabels(error) {
  const labels = new Set();
  const pending = [error];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const code = typeof current.code === "string" ? current.code : "";
    const failureType = typeof current.failureType === "string" ? current.failureType : "";
    const message = typeof current.message === "string" ? current.message : "";
    if (["EACCES", "EPERM"].includes(code) || /listen (?:EACCES|EPERM)/u.test(message)) {
      labels.add("loopback-permission");
    }
    if (code === "EADDRINUSE" || /listen EADDRINUSE/u.test(message)) {
      labels.add("loopback-address-collision");
    }
    if (code === "ERR_MODULE_NOT_FOUND" || /Cannot find (?:module|package)/u.test(message)) {
      labels.add("missing-module");
    }
    if (["uncaughtException", "unhandledRejection"].includes(failureType)) {
      labels.add(failureType);
    }
    if (["cancelledByParent", "testTimeoutFailure"].includes(failureType)) {
      labels.add("test-timeout-or-cancellation");
    }
    if (current.cause !== undefined) pending.push(current.cause);
    if (Array.isArray(current.errors)) pending.push(...current.errors);
  }
  return [...labels].sort();
}

export default async function* redInventoryReporter(source) {
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const error = event.data.details?.error;
    const file = event.data.file === undefined ? undefined : basename(event.data.file);
    yield `${JSON.stringify({
      status: event.type === "test:pass" ? "pass" : "fail",
      name: event.data.name,
      nesting: event.data.nesting,
      file,
      skip: event.data.skip !== undefined && event.data.skip !== false,
      todo: event.data.todo !== undefined && event.data.todo !== false,
      signature: error === undefined ? undefined : failureSignature(error, file),
      marker: error === undefined ? undefined : reviewedMarker(error),
      infrastructure: error === undefined ? [] : infrastructureLabels(error),
    })}\n`;
  }
}
