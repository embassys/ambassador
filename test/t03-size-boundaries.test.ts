import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import test, { type TestContext } from "node:test";

import { startFakeCentral } from "./support/fake-central.js";
import { startFakeWebhook } from "./support/fake-webhook.js";
import { startGateway } from "./support/start-gateway.js";
import {
  capturingCredentialStore,
  seededCredentialV2,
  T03_WEBHOOK_TOKEN,
  type T03CredentialRecord,
  useT03FixtureClock,
} from "./support/t03-contract-fixtures.js";
import {
  startT03ScriptedCentralApi,
  type T03ScriptedRequest,
  waitForT03Observation,
} from "./support/t03-observation.js";

function compactJsonPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function tokenAtLength(source: string, target: number): string {
  const parts = source.split(".");
  assert.equal(parts.length, 3);
  const header = JSON.parse(Buffer.from(parts[0] ?? "", "base64url").toString("utf8")) as unknown;
  const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  const signature = Buffer.alloc(64).toString("base64url");
  for (const paddingClaim of ["a", "aa", "aaa", "aaaa"]) {
    for (let padding = 0; padding <= 8_192; padding += 1) {
      const token = `${compactJsonPart(header)}.${compactJsonPart({
        ...payload,
        [paddingClaim]: "x".repeat(padding),
      })}.${signature}`;
      if (Buffer.byteLength(token, "ascii") === target) return token;
    }
  }
  assert.fail("could not construct the exact token boundary");
}

function derLength(value: number): Buffer {
  if (value < 128) return Buffer.from([value]);
  const bytes: number[] = [];
  for (let remaining = value; remaining > 0; remaining = Math.floor(remaining / 256)) {
    bytes.unshift(remaining & 0xff);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.byteLength), content]);
}

function derContent(value: Buffer): Buffer {
  assert.equal(value[0], 0x30);
  const firstLength = value[1];
  assert.ok(firstLength !== undefined);
  const lengthBytes = firstLength < 0x80 ? 0 : firstLength & 0x7f;
  return value.subarray(2 + lengthBytes);
}

/** Adds a valid ignored PKCS#8 attribute without changing the P-256 key. */
function privateKeyAtOrAbove(source: string, minimum: number): string {
  const original = Buffer.from(source, "base64url");
  const baseContent = derContent(original);
  const friendlyNameOid = Buffer.from("06092a864886f70d010914", "hex");
  let smallest: string | undefined;
  for (let padding = 0; padding <= 1_024; padding += 1) {
    const value = derTlv(0x0c, Buffer.alloc(padding, 0x61));
    const set = derTlv(0x31, value);
    const attribute = derTlv(0x30, Buffer.concat([friendlyNameOid, set]));
    const encoded = derTlv(0x30, Buffer.concat([baseContent, derTlv(0xa0, attribute)]));
    const text = encoded.toString("base64url");
    if (text.length < minimum || (smallest !== undefined && text.length >= smallest.length))
      continue;
    const imported = createPrivateKey({ key: encoded, format: "der", type: "pkcs8" });
    assert.equal(imported.asymmetricKeyType, "ec");
    smallest = text;
  }
  assert.ok(smallest !== undefined, "could not construct the private-key boundary");
  return smallest;
}

function padRecord(record: T03CredentialRecord, target: number): string {
  const serialized = JSON.stringify(record);
  assert.ok(serialized.length <= target);
  return serialized.padEnd(target, " ");
}

async function recordScenario(
  t: TestContext,
  record: string,
): Promise<{
  readonly requests: readonly T03ScriptedRequest[];
  readonly start: ReturnType<typeof startGateway>;
}> {
  useT03FixtureClock(t);
  const central = await startFakeCentral(t);
  const api = await startT03ScriptedCentralApi(t, [{ status: 200, hold: true }]);
  const webhook = await startFakeWebhook(t);
  const start = startGateway(t, {
    webhookUrl: webhook.url,
    webhookToken: T03_WEBHOOK_TOKEN,
    centralApiUrl: api.url,
    centralMcpUrl: central.mcpUrl,
    credentialStore: capturingCredentialStore(record).adapter,
  });
  return { requests: api.requests, start };
}

test("T03-L01 exact credential token, key, and plaintext boundaries are enforced", async (t) => {
  const central = await startFakeCentral(t);
  const base = seededCredentialV2(central, "fixture_sender");
  const token4096 = tokenAtLength(base.access_token, 4_096);
  const key1024 = privateKeyAtOrAbove(base.dpop_private_key_pkcs8, 1_024);
  assert.equal(key1024.length, 1_024);
  const validKeyOverLimit = privateKeyAtOrAbove(base.dpop_private_key_pkcs8, 1_025);
  assert.ok(validKeyOverLimit.length > 1_024);
  const validTokenRecord: T03CredentialRecord = { ...base, access_token: token4096 };
  const validKeyRecord: T03CredentialRecord = { ...base, dpop_private_key_pkcs8: key1024 };
  const vectors: ReadonlyArray<{
    readonly name: string;
    readonly record: string;
    readonly accepted: boolean;
    readonly expectedToken?: string;
  }> = [
    {
      name: "token 4096",
      record: JSON.stringify(validTokenRecord),
      accepted: true,
      expectedToken: token4096,
    },
    {
      name: "token 4097",
      record: JSON.stringify({ ...base, access_token: "x".repeat(4_097) }),
      accepted: false,
    },
    {
      name: "smallest canonical token over limit",
      record: JSON.stringify({ ...base, access_token: tokenAtLength(base.access_token, 4_098) }),
      accepted: false,
    },
    { name: "private key 1024", record: JSON.stringify(validKeyRecord), accepted: true },
    {
      name: "private key 1025",
      record: JSON.stringify({ ...base, dpop_private_key_pkcs8: `${key1024}A` }),
      accepted: false,
    },
    {
      name: "smallest valid private key over limit",
      record: JSON.stringify({ ...base, dpop_private_key_pkcs8: validKeyOverLimit }),
      accepted: false,
    },
    { name: "plaintext 8192", record: padRecord(base, 8_192), accepted: true },
    { name: "plaintext 8193", record: padRecord(base, 8_193), accepted: false },
  ];

  for (const vector of vectors) {
    await t.test(vector.name, async (subtest) => {
      const scenario = await recordScenario(subtest, vector.record);
      if (!vector.accepted) {
        await assert.rejects(scenario.start);
        assert.equal(scenario.requests.length, 0, "over-limit credential reached central");
        return;
      }
      const gateway = await scenario.start;
      await waitForT03Observation(() => scenario.requests.length > 0);
      const request = scenario.requests[0];
      assert.ok(request !== undefined);
      const authorization = request.headers.authorization;
      assert.ok(
        typeof authorization === "string" && authorization.startsWith("DPoP "),
        "boundary credential did not use DPoP",
      );
      if (vector.expectedToken !== undefined) {
        assert.equal(Buffer.byteLength(authorization, "ascii"), 4_101);
      }
      const proof = request.headers.dpop;
      assert.ok(typeof proof === "string", "boundary credential omitted proof");
      assert.ok(Buffer.byteLength(proof, "ascii") <= 4_096);
      assert.ok(
        Buffer.byteLength(authorization, "ascii") + Buffer.byteLength(proof, "ascii") <= 8_197,
      );
      assert.ok(request.rawHeaderBytes <= 16_384, "gateway-generated headers exceeded 16 KiB");
      await gateway.stop();
    });
  }
});
