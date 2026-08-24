import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type AgentConfig,
  bindingFingerprint,
  parseConfig,
  resolveSecret,
  type SecretReference,
  type SidecarConfig,
} from "../src/config.js";

const config: SidecarConfig = {
  version: 1,
  controller: {
    base_url: "https://controller.example",
    token: { source: "env", name: "A2A_CONTROLLER_TOKEN" },
    poll_wait_seconds: 30,
    max_notifications: 50,
    queue_capacity: 1_000,
  },
  agents: [
    {
      binding_id: "binding_generic",
      adapter: {
        type: "generic",
        url: "http://127.0.0.1:8644/webhooks/a2a",
        health_url: "http://127.0.0.1:8644/health",
        secret: { source: "env", name: "A2A_GENERIC_SECRET" },
      },
    },
    {
      binding_id: "binding_hermes",
      adapter: {
        type: "hermes",
        url: "http://127.0.0.1:8645/webhooks/a2a",
        secret: { source: "env", name: "A2A_HERMES_SECRET" },
      },
    },
    {
      binding_id: "binding_openclaw",
      adapter: {
        type: "openclaw",
        url: "http://127.0.0.1:8646/hooks/agent",
        agent_id: "agent_local",
        token: { source: "env", name: "A2A_OPENCLAW_TOKEN" },
      },
    },
  ],
};

function assertConfigError(operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof Error);
    return error.name !== "NotImplementedError";
  });
}

test("parseConfig accepts the strict version 1 adapter shapes", () => {
  assert.deepEqual(parseConfig(config), config);
});

test("parseConfig rejects unsupported versions and malformed secret references", () => {
  const unsupportedVersion = { ...config, version: 2 };
  const fileToken = structuredClone(config);
  Object.assign(fileToken.controller.token, {
    source: "file",
    path: "/run/secrets/a2a",
  });
  const literalToken = structuredClone(config);
  Object.assign(literalToken.controller.token, {
    source: "literal",
    value: "plaintext-secret",
  });

  for (const invalidConfig of [unsupportedVersion, fileToken, literalToken]) {
    assertConfigError(() => parseConfig(invalidConfig));
  }
});

test("parseConfig rejects unknown fields throughout the document", () => {
  const rootField = { ...config, telemetry: true };
  const controllerField = structuredClone(config);
  Object.assign(controllerField.controller, { future_field: true });
  const agentField = structuredClone(config);
  const agent = agentField.agents[0];
  assert.ok(agent);
  Object.assign(agent, { prompt: "forbidden" });
  const adapterField = structuredClone(config);
  const adapter = adapterField.agents[0]?.adapter;
  assert.ok(adapter);
  Object.assign(adapter, { headers: { authorization: "x" } });
  const secretField = structuredClone(config);
  const adapterWithSecret = secretField.agents[0]?.adapter;
  assert.ok(adapterWithSecret);
  Object.assign(adapterWithSecret, {
    secret: {
      source: "env",
      name: "A2A_GENERIC_SECRET",
      value: "plaintext-secret",
    },
  });

  for (const invalidConfig of [rootField, controllerField, agentField, adapterField, secretField]) {
    assertConfigError(() => parseConfig(invalidConfig));
  }
});

test("parseConfig rejects duplicate binding IDs", () => {
  const duplicate = structuredClone(config);
  const firstAgent = duplicate.agents[0];
  assert.ok(firstAgent);
  duplicate.agents.push(structuredClone(firstAgent));

  assertConfigError(() => parseConfig(duplicate));
});

test("parseConfig rejects unsafe transport URLs and invalid environment names", () => {
  const invalidConfigs: unknown[] = [];

  for (const base_url of [
    "http://controller.example",
    "file:///tmp/controller",
    "https://user:password@controller.example",
  ]) {
    const candidate = structuredClone(config);
    candidate.controller.base_url = base_url;
    invalidConfigs.push(candidate);
  }

  for (const url of ["http://192.168.1.20:8644/wake", "ftp://127.0.0.1/wake"]) {
    const candidate = structuredClone(config);
    const adapter = candidate.agents[0]?.adapter;
    assert.ok(adapter);
    adapter.url = url;
    invalidConfigs.push(candidate);
  }

  const invalidEnvironment = structuredClone(config);
  invalidEnvironment.controller.token.name = "NOT A VALID ENVIRONMENT NAME";
  invalidConfigs.push(invalidEnvironment);

  for (const invalidConfig of invalidConfigs) {
    assertConfigError(() => parseConfig(invalidConfig));
  }
});

test("resolveSecret reads only the requested environment reference", () => {
  const secret = "controller-token-value";
  const reference = {
    source: "env",
    name: "A2A_CONTROLLER_TOKEN",
  } satisfies SecretReference;
  const originalReference = structuredClone(reference);

  assert.equal(
    resolveSecret(reference, {
      A2A_CONTROLLER_TOKEN: secret,
      UNRELATED_SECRET: "must-not-be-returned",
    }),
    secret,
  );
  assert.deepEqual(reference, originalReference);
  assert.equal(JSON.stringify(reference).includes(secret), false);
});

test("resolveSecret reports a missing variable without leaking other values", () => {
  const unrelatedSecret = "unrelated-private-value";

  assert.throws(
    () =>
      resolveSecret(
        { source: "env", name: "A2A_MISSING_TOKEN" },
        { UNRELATED_SECRET: unrelatedSecret },
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.notEqual(error.name, "NotImplementedError");
      assert.equal(
        `${error.name}: ${error.message} ${JSON.stringify(error)}`.includes(unrelatedSecret),
        false,
      );
      return true;
    },
  );
});

test("bindingFingerprint is stable and excludes resolved secret values", () => {
  const environmentName = "A2A_FINGERPRINT_TEST_SECRET";
  const previousValue = process.env[environmentName];
  const agent = {
    binding_id: "binding_generic",
    adapter: {
      type: "generic",
      url: "http://127.0.0.1:8644/webhooks/a2a",
      secret: { source: "env", name: environmentName },
    },
  } satisfies AgentConfig;
  const equivalentAgent = {
    adapter: {
      secret: { name: environmentName, source: "env" },
      url: "http://127.0.0.1:8644/webhooks/a2a",
      type: "generic",
    },
    binding_id: "binding_generic",
  } satisfies AgentConfig;

  try {
    process.env[environmentName] = "first-secret-value";
    const first = bindingFingerprint(agent);
    process.env[environmentName] = "second-secret-value";
    const second = bindingFingerprint(equivalentAgent);

    assert.notEqual(first, "");
    assert.equal(second, first);
    assert.equal(first.includes("first-secret-value"), false);
    assert.equal(second.includes("second-secret-value"), false);
    assert.notEqual(
      bindingFingerprint({
        ...agent,
        adapter: { ...agent.adapter, url: "http://127.0.0.1:9999/wake" },
      }),
      first,
    );
    assert.notEqual(
      bindingFingerprint({
        ...agent,
        adapter: {
          ...agent.adapter,
          secret: { source: "env", name: "A2A_OTHER_SECRET" },
        },
      }),
      first,
    );
  } finally {
    if (previousValue === undefined) {
      delete process.env[environmentName];
    } else {
      process.env[environmentName] = previousValue;
    }
  }
});
