import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { capabilityForKind } from "../src/agent-capabilities.js";
import { CentralEnrollmentClient, CentralEnrollmentError } from "../src/central-enrollment.js";
import { createDeliveryProfile, DeliveryProfileStore } from "../src/delivery-profile.js";
import { parseDesktopCommand } from "../src/desktop/protocol.js";
import { DesktopRegistration } from "../src/desktop/registration.js";
import { GatewayIdentity } from "../src/identity.js";
import { startFakeCentral } from "./support/fake-central.js";

test("CLI registration can finish in the app and app registration can finish in CLI", async (t) => {
  for (const cliFirst of [true, false]) {
    const f = await setup(t);
    const email = `${cliFirst ? "cli" : "app"}-handoff@fixture.test`;
    const capability = capabilityForKind("claude");
    assert.ok(capability);
    const profile = await createDeliveryProfile(
      capability,
      { mode: "direct" },
      f.options.workingDirectory,
    );
    let registration = await DesktopRegistration.open(f.options);
    if (cliFirst) await registration.registerFromTools({ email }, profile);
    else await registration.register({ email, executor: "claude" });
    registration = await DesktopRegistration.open(f.options);
    const count = f.central.requests().length;
    await registration.registerFromTools({ email }, profile);
    assert.equal(f.central.requests().length, count);
    await assert.rejects(
      registration.verifyFromTools({ email: "wrong@fixture.test", code: "123456" }),
    );
    if (cliFirst) await registration.verify(f.central.verificationCode(email));
    else await registration.verifyFromTools({ email, code: f.central.verificationCode(email) });
    assert.equal(registration.snapshot().phase, "registered");
    assert.equal(f.options.identity.enrollment.email, email);
  }
});

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "embassys-registration-"));
  const central = await startFakeCentral();
  t.after(async () => {
    await central.close();
    await rm(root, { recursive: true, force: true });
  });
  let saved: string | undefined;
  const store = {
    load: async () => saved,
    save: async (value: string) => {
      saved = value;
    },
  };
  const identity = await GatewayIdentity.open(store);
  const client = new CentralEnrollmentClient({ centralOrigin: central.apiUrl });
  let activations = 0;
  const options = {
    path: join(root, "registration.json"),
    profileStore: new DeliveryProfileStore(join(root, "profile.json")),
    workingDirectory: root,
    identity,
    client,
    activate: async () => {
      activations++;
    },
  };
  return { root, central, options, store, activations: () => activations };
}

test("email registration defers executor choice and activation until the owner finishes setup", async (t) => {
  const f = await setup(t);
  let registration = await DesktopRegistration.open(f.options);
  await registration.register({ email: "first-account@fixture.test" });
  assert.equal(await f.options.profileStore.load(), undefined);
  await registration.verify(f.central.verificationCode("first-account@fixture.test"));
  assert.equal(f.activations(), 0);
  assert.equal(registration.needsExecutor, true);
  registration = await DesktopRegistration.open(f.options);
  assert.equal(registration.snapshot().needsExecutor, true);
  await assert.rejects(registration.selectExecutor("shell"));
  const calls = f.central.requests().length;
  await registration.selectExecutor("codex");
  assert.equal(f.activations(), 1);
  assert.equal(f.central.requests().length, calls);
  assert.equal((await f.options.profileStore.load())?.agent_kind, "codex");
  assert.equal(registration.needsExecutor, false);
  await registration.selectExecutor("codex");
  await assert.rejects(registration.selectExecutor("claude"));
  assert.equal(f.central.requests().length, calls);
});

test("retrying selected executor activation never registers or verifies again", async (t) => {
  const f = await setup(t);
  let fail = true;
  let activated = false;
  const registration = await DesktopRegistration.open({
    ...f.options,
    activate: async () => {
      if (fail) throw new Error("temporarily unavailable");
      activated = true;
    },
  });
  await registration.register({ email: "deferred-retry@fixture.test" });
  await registration.verify(f.central.verificationCode("deferred-retry@fixture.test"));
  const count = f.central.requests().length;
  await assert.rejects(registration.selectExecutor("claude"));
  fail = false;
  await registration.selectExecutor("claude");
  assert.equal(activated, true);
  assert.equal(registration.snapshot().executor, "claude");
  assert.equal(f.central.requests().length, count);
});

test("desktop registration binds the executor and email, survives restart and keeps secrets out of UI state", async (t) => {
  const f = await setup(t);
  let registration = await DesktopRegistration.open(f.options);
  const input = { email: "desktop@fixture.test", executor: "claude" as const };
  assert.equal((await registration.register(input)).phase, "awaiting_code");
  assert.equal((await f.options.profileStore.load())?.agent_kind, "claude");
  registration = await DesktopRegistration.open(f.options);
  assert.equal(registration.snapshot().email, input.email);
  await assert.rejects(registration.register({ ...input, email: "changed@fixture.test" }));
  assert.equal((await registration.verify("000000")).phase, "awaiting_code");
  const result = await registration.verify(f.central.verificationCode(input.email));
  assert.equal(result.phase, "registered");
  assert.equal((await registration.verify("123456")).phase, "registered");
  assert.equal(f.activations(), 1);
  assert.equal((await GatewayIdentity.open(f.store)).enrollment.email, input.email);
  const contents = await readFile(f.options.path, "utf8");
  assert.ok(!contents.includes(f.central.verificationCode(input.email)));
  assert.doesNotMatch(JSON.stringify(result), /token|private|jwk/i);
  assert.equal((await DesktopRegistration.open(f.options)).snapshot().phase, "registered");
});

test("lost registration responses are not repeated and an emailed code can finish the saved attempt", async (t) => {
  const f = await setup(t);
  let writes = 0;
  const client = {
    register: async (input: unknown) => {
      writes++;
      await f.options.client.register(input);
      throw new CentralEnrollmentError("central_enrollment_outcome_uncertain");
    },
    verify: f.options.client.verify.bind(f.options.client),
    resend: f.options.client.resend.bind(f.options.client),
  };
  const options = { ...f.options, client };
  const input = { email: "lost@fixture.test", executor: "codex" as const };
  let registration = await DesktopRegistration.open(options);
  assert.equal((await registration.register(input)).phase, "registration_uncertain");
  registration = await DesktopRegistration.open(options);
  await registration.register(input);
  assert.equal(writes, 1);
  assert.equal(
    (await registration.verify(f.central.verificationCode(input.email))).phase,
    "registered",
  );
});

test("lost verification never triggers a second key-binding request", async (t) => {
  const f = await setup(t);
  let verifications = 0;
  const client = {
    register: f.options.client.register.bind(f.options.client),
    resend: f.options.client.resend.bind(f.options.client),
    verify: async () => {
      verifications++;
      throw new CentralEnrollmentError("central_enrollment_outcome_uncertain");
    },
  };
  const options = { ...f.options, client };
  let registration = await DesktopRegistration.open(options);
  await registration.register({ email: "verify-lost@fixture.test", executor: "hermes" });
  assert.equal((await registration.verify("123456")).phase, "verification_uncertain");
  registration = await DesktopRegistration.open(options);
  await registration.verify("123456");
  assert.equal(verifications, 1);
  assert.equal(f.options.identity.enrolled, false);
});

test("a failed credential write leaves verification uncertain across restart", async (t) => {
  const f = await setup(t);
  f.store.save = async () => {
    throw new Error("disk full");
  };
  let registration = await DesktopRegistration.open(f.options);
  await registration.register({ email: "disk@fixture.test", executor: "claude" });
  assert.equal(
    (await registration.verify(f.central.verificationCode("disk@fixture.test"))).phase,
    "verification_uncertain",
  );
  const calls = f.central.requests().length;
  registration = await DesktopRegistration.open(f.options);
  await registration.verify("123456");
  assert.equal(f.central.requests().length, calls);
  assert.equal(f.options.identity.enrolled, false);
});

test("activation failure preserves the registered identity and never repeats verification", async (t) => {
  const f = await setup(t);
  const options = {
    ...f.options,
    activate: async () => {
      throw new Error("executor unavailable");
    },
  };
  const registration = await DesktopRegistration.open(options);
  await registration.register({ email: "activation@fixture.test", executor: "codex" });
  await assert.rejects(registration.verify(f.central.verificationCode("activation@fixture.test")));
  assert.equal(registration.snapshot().phase, "registered");
  assert.equal((await DesktopRegistration.open(options)).snapshot().phase, "registered");
  const calls = f.central.requests().length;
  await registration.verify("123456");
  assert.equal(f.central.requests().length, calls);
});

test("an existing email is a conflict and never becomes a recovery or repeat registration", async (t) => {
  const f = await setup(t);
  f.central.seedClient("existing@fixture.test");
  const registration = await DesktopRegistration.open(f.options);
  const input = { email: "existing@fixture.test", executor: "claude" as const };
  assert.equal((await registration.register(input)).phase, "conflict");
  const calls = f.central.requests().length;
  await registration.register(input);
  await assert.rejects(registration.resend());
  await assert.rejects(registration.verify("123456"));
  assert.equal(f.central.requests().length, calls);
});

test("resend binds the saved email and persists cooldown even when its response is lost", async (t) => {
  const f = await setup(t);
  let now = 100_000;
  let sends = 0;
  const options = {
    ...f.options,
    now: () => now,
    client: {
      register: f.options.client.register.bind(f.options.client),
      verify: f.options.client.verify.bind(f.options.client),
      resend: async (raw: unknown) => {
        assert.deepEqual(raw, { email: "resend@fixture.test" });
        sends++;
        throw new CentralEnrollmentError("central_enrollment_outcome_uncertain");
      },
    },
  };
  let registration = await DesktopRegistration.open(options);
  await registration.register({ email: "resend@fixture.test", executor: "hermes" });
  await assert.rejects(registration.resend());
  now += 60_000;
  await registration.resend();
  registration = await DesktopRegistration.open(options);
  await assert.rejects(registration.resend());
  assert.equal(sends, 1);
});

test("concurrent registration cannot create a second identity", async (t) => {
  const f = await setup(t);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const registration = await DesktopRegistration.open({
    ...f.options,
    client: {
      ...f.options.client,
      verify: f.options.client.verify.bind(f.options.client),
      resend: f.options.client.resend.bind(f.options.client),
      register: async (input: unknown) => {
        calls++;
        await blocked;
        return f.options.client.register(input);
      },
    },
  });
  const first = registration.register({ email: "first@fixture.test", executor: "codex" });
  await assert.rejects(registration.register({ email: "second@fixture.test", executor: "claude" }));
  release();
  await first;
  assert.equal(calls, 1);
});

test("verification cannot commit a different central identity", async (t) => {
  const f = await setup(t);
  const registration = await DesktopRegistration.open({
    ...f.options,
    client: {
      register: f.options.client.register.bind(f.options.client),
      resend: f.options.client.resend.bind(f.options.client),
      verify: async (input: unknown) => {
        const result = await f.options.client.verify(input);
        return { ...result, localResult: { ...result.localResult, agent_id: "foreign-agent" } };
      },
    },
  });
  await registration.register({ email: "binding@fixture.test", executor: "claude" });
  assert.equal(
    (await registration.verify(f.central.verificationCode("binding@fixture.test"))).phase,
    "verification_uncertain",
  );
  assert.equal(f.options.identity.enrolled, false);
});

test("desktop IPC rejects credentials, arbitrary executors, foreign email verification and approval commands", () => {
  const instanceId = "00000000-0000-4000-8000-000000000001";
  assert.equal(
    parseDesktopCommand({
      type: "enrollment_register",
      instanceId,
      email: "one@fixture.test",
      executor: "claude",
    }).type,
    "enrollment_register",
  );
  for (const command of [
    { type: "enrollment_register", instanceId, email: "one@fixture.test", executor: "/bin/sh" },
    { type: "enrollment_verify", instanceId, code: "123456", email: "other@fixture.test" },
    { type: "enrollment_verify", instanceId, code: "abcdef" },
    { type: "permissions", instanceId, token: "private" },
    { type: "permission_decision", instanceId, decision: "allow_always" },
  ])
    assert.throws(() => parseDesktopCommand(command));
});
