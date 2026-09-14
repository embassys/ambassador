import assert from "node:assert/strict";
import { test } from "node:test";
import { CentralProtectedTransport } from "../src/central-protected-transport.js";
import { CentralRenewal } from "../src/central-renewal.js";
import { GatewayIdentity } from "../src/identity.js";
import { currentCredential, FIXTURE_NOW_SECONDS } from "./support/current-credential.js";

async function fixture() {
  let saved = currentCredential();
  let now = FIXTURE_NOW_SECONDS;
  let failSave = false;
  const identity = await GatewayIdentity.open(
    {
      load: async () => saved,
      save: async (value) => {
        if (failSave) throw new Error("disk full");
        saved = value;
      },
    },
    () => now,
  );
  const old = identity.localCredential();
  now = old.token.expiresAt + 1;
  return {
    identity,
    old,
    now: () => now,
    failSave: () => {
      failSave = true;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}
function response(f: Awaited<ReturnType<typeof fixture>>, overrides = {}) {
  const claims = {
    sub: f.old.token.subject,
    email: f.old.token.email,
    iat: f.now(),
    exp: f.now() + 2592000,
    cnf: { jkt: f.old.keyThumbprint },
    ...overrides,
  };
  return Response.json(
    {
      agent_id: claims.sub,
      email: claims.email,
      token: `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`,
      jkt: f.old.keyThumbprint,
      expires_at: new Date(claims.exp * 1000).toISOString(),
      previous_token_valid_until: new Date((f.now() + 300) * 1000).toISOString(),
      message: "Token renewed.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
test("expired tokens only reach the dedicated renewal route and concurrent renewal commits one same-key credential", async () => {
  const f = await fixture();
  let requests = 0;
  const transport = new CentralProtectedTransport({
    credential: () => f.identity.localCredential(),
    now: f.now,
    fetch: async (url, init) => {
      assert.equal(String(url), "https://central.fixture.test/api/renew_token");
      assert.equal(init?.method, "POST");
      requests++;
      return response(f);
    },
  });
  await assert.rejects(transport.fetch("https://central.fixture.test/api/list_action_types"));
  await assert.rejects(transport.fetchRenewal("https://central.fixture.test/api/call_action"));
  const renewal = new CentralRenewal(f.identity, transport, "https://central.fixture.test", f.now);
  await Promise.all([renewal.ensure(), renewal.ensure(), renewal.ensure()]);
  assert.equal(requests, 1);
  assert.equal(f.identity.expired, false);
  assert.equal(
    f.identity.localCredential().record.dpop_private_key_pkcs8,
    f.old.record.dpop_private_key_pkcs8,
  );
  assert.equal(f.identity.localCredential().token.subject, f.old.token.subject);
});
test("invalid renewed identity and failed persistence preserve the old credential", async () => {
  for (const diskFailure of [true, false]) {
    const f = await fixture();
    if (diskFailure) f.failSave();
    const transport = new CentralProtectedTransport({
      credential: () => f.identity.localCredential(),
      now: f.now,
      fetch: async () => response(f, diskFailure ? {} : { sub: "different-agent" }),
    });
    const renewal = new CentralRenewal(
      f.identity,
      transport,
      "https://central.fixture.test",
      f.now,
    );
    await assert.rejects(renewal.ensure());
    assert.equal(f.identity.localCredential().serialized, f.old.serialized);
  }
});
test("past-grace credentials stay local and do not get sent to a protected endpoint", async () => {
  const f = await fixture();
  f.setNow(f.old.token.expiresAt + 14 * 86400 + 1);
  const transport = new CentralProtectedTransport({
    credential: () => f.identity.localCredential(),
    now: f.now,
    fetch: async () => {
      assert.fail("must stay local");
    },
  });
  await assert.rejects(
    new CentralRenewal(f.identity, transport, "https://central.fixture.test", f.now).ensure(),
  );
});

test("renewal replaces the encrypted file atomically and remains readable after reopening", async (t) => {
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { EncryptedFileCredentialStore } = await import("../src/credential-store.js");
  const root = await mkdtemp(join(tmpdir(), "embassys-renew-file-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EncryptedFileCredentialStore(
    join(root, "credential.enc"),
    join(root, "key"),
    "renew-test",
  );
  await store.save(currentCredential());
  let currentTime = FIXTURE_NOW_SECONDS;
  const now = () => currentTime;
  const identity = await GatewayIdentity.open(store, now);
  const old = identity.localCredential();
  currentTime = old.token.expiresAt + 1;
  const transport = new CentralProtectedTransport({
    credential: () => identity.localCredential(),
    now,
    fetch: async () => response({ old, now } as Awaited<ReturnType<typeof fixture>>),
  });
  await new CentralRenewal(identity, transport, "https://central.fixture.test", now).ensure();
  const reopened = await GatewayIdentity.open(store, now);
  assert.equal(reopened.expired, false);
  assert.equal(reopened.localCredential().keyThumbprint, old.keyThumbprint);
  await assert.rejects(store.replace(old.serialized, old.serialized));
  assert.equal(await store.load(), reopened.localCredential().serialized);
  assert.equal(
    (await readFile(join(root, "credential.enc"))).includes(old.record.dpop_private_key_pkcs8),
    false,
  );
});
