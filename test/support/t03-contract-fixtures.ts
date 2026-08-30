import assert from "node:assert/strict";
import { createECDH, createPrivateKey, type JsonWebKey } from "node:crypto";
import type { TestContext } from "node:test";

import type { CredentialStore, VersionedCredentialStore } from "../../src/credential-store.js";
import { type FakeCentral, startFakeCentral } from "./fake-central.js";
import { startFakeWebhook } from "./fake-webhook.js";
import { TestMcpClient } from "./mcp-client.js";
import { startGateway } from "./start-gateway.js";

export const T03_WEBHOOK_TOKEN = "7301a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7";
export const T03_EMAIL = "t03-gateway@fixture.invalid";
export const T03_USERNAME = "t03_gateway";
export const T03_CODE = "123456";

export interface T03CredentialRecord {
  readonly credential_version: 2;
  readonly token_type: "DPoP";
  readonly access_token: string;
  readonly dpop_alg: "ES256";
  readonly dpop_private_key_pkcs8: string;
}

export interface T03CapturingCredentialStore {
  readonly adapter: CredentialStore & VersionedCredentialStore;
  readonly saved: readonly string[];
}

export interface T03GatewayScenario {
  readonly central: FakeCentral;
  readonly client: TestMcpClient;
  readonly gateway: Awaited<ReturnType<typeof startGateway>>;
  readonly credentials: T03CapturingCredentialStore;
}

/**
 * The adapter preserves the shipped string interface while recording the
 * runtime value. This lets the red suite observe the future record boundary
 * without adding a production-only test hook.
 */
export function capturingCredentialStore(initial?: string): T03CapturingCredentialStore {
  const saved: string[] = [];
  const adapter: CredentialStore & VersionedCredentialStore = {
    async load() {
      return undefined;
    },
    async save() {
      throw new Error("T03 version 2 state reached the legacy credential store API");
    },
    async loadCredential() {
      return initial === undefined ? undefined : { version: 2, plaintext: initial };
    },
    async saveCredential(credential) {
      assert.equal(credential.version, 2);
      saved.push(credential.plaintext);
    },
  };
  return { adapter, saved };
}

export async function startT03GatewayScenario(
  t: TestContext,
  options: { readonly initialCredential?: string; readonly verbose?: boolean } = {},
): Promise<T03GatewayScenario> {
  useT03FixtureClock(t);
  const central = await startFakeCentral(t);
  const webhook = await startFakeWebhook(t);
  const credentials = capturingCredentialStore(options.initialCredential);
  const gateway = await startGateway(t, {
    webhookUrl: webhook.url,
    webhookToken: T03_WEBHOOK_TOKEN,
    centralApiUrl: central.apiUrl,
    centralMcpUrl: central.mcpUrl,
    credentialStore: credentials.adapter,
    targetContract: "v2",
    ...(options.verbose === true ? { verbose: true } : {}),
  });
  const client = new TestMcpClient(gateway.endpoint, T03_WEBHOOK_TOKEN);
  await client.initialize();
  return { central, client, gateway, credentials };
}

export function useT03FixtureClock(t: TestContext): void {
  t.mock.timers.enable({ apis: ["Date"], now: 1_788_000_000_000 });
}

export async function registerPendingIdentity(central: FakeCentral): Promise<void> {
  const response = await fetch(new URL("/api/register", central.apiUrl), {
    method: "POST",
    redirect: "manual",
    headers: {
      accept: "application/json",
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ email: T03_EMAIL, username: T03_USERNAME }),
  });
  assert.equal(response.status, 200);
  await response.body?.cancel();
}

export function seededCredentialV2(
  central: FakeCentral,
  username: "fixture_sender" | "fixture_recipient" | "fixture_denied",
): T03CredentialRecord {
  const scalar = username === "fixture_sender" ? 2 : username === "fixture_recipient" ? 3 : 4;
  const token = central.seedClient(username).accessToken;
  assert.ok(token !== undefined);
  return {
    credential_version: 2,
    token_type: "DPoP",
    access_token: token,
    dpop_alg: "ES256",
    dpop_private_key_pkcs8: privateKeyPkcs8(scalar),
  };
}

function privateKeyPkcs8(scalar: number): string {
  const privateBytes = Buffer.alloc(32);
  privateBytes.writeUInt32BE(scalar, 28);
  const curve = createECDH("prime256v1");
  curve.setPrivateKey(privateBytes);
  const point = curve.getPublicKey(undefined, "uncompressed");
  const key = createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33, 65).toString("base64url"),
      d: privateBytes.toString("base64url"),
    } as JsonWebKey,
  });
  return Buffer.from(key.export({ format: "der", type: "pkcs8" })).toString("base64url");
}
