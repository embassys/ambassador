import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DesktopGateway } from "../src/desktop/gateway.js";
import { currentCredentialRecord } from "./support/current-credential.js";

const id = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";
const deviceId = "00000000-0000-4000-8000-000000000003";
function credential() {
  const value = currentCredentialRecord(
    "owner@fixture.test",
    agentId,
    Math.floor(Date.now() / 1000),
  );
  const pieces = value.access_token.split(".");
  const payload = JSON.parse(Buffer.from(pieces[1] ?? "", "base64url").toString());
  return {
    ...value,
    access_token: `${pieces[0]}.${Buffer.from(JSON.stringify({ ...payload, dev: deviceId, fence: 1 })).toString("base64url")}.${pieces[2]}`,
  };
}
test("execution installation holds the stopped instance lock and cannot install after cancellation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-execution-import-"));
  const options = {
    id,
    name: "Fixture",
    stateDirectory: join(root, "state"),
    workingDirectory: join(root, "work"),
    port: 18888,
    environment: process.env,
  };
  const gateway = new DesktopGateway(options);
  t.after(async () => {
    await gateway.stop();
    await rm(root, { recursive: true, force: true });
  });
  const preview = await gateway.prepareExecution(agentId);
  const other = new DesktopGateway(options);
  await assert.rejects(other.prepareExecution(agentId));
  await gateway.cancelExecution(preview);
  await assert.rejects(gateway.installExecution(preview, credential()));
  const fresh = await gateway.prepareExecution(agentId);
  await gateway.installExecution(fresh, credential());
  await assert.rejects(gateway.prepareExecution(deviceId), /different agent/i);
});
