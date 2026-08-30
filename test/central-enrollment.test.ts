import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  CentralEnrollmentClient,
  CentralEnrollmentError,
  type CentralTokenProfile,
} from "../src/central-enrollment.js";
import { T03_CODE, T03_EMAIL, T03_USERNAME } from "./support/t03-contract-fixtures.js";
import {
  startT03ScriptedCentralApi,
  type T03ResponsePlan,
  waitForT03Observation,
} from "./support/t03-observation.js";

const TOKEN_PROFILE: CentralTokenProfile = {
  issuer: "urn:a2a:fixture:issuer:v2",
  audiences: ["urn:a2a:fixture:resource:api:v2", "urn:a2a:fixture:resource:mcp:v2"],
};
const OVERSIZED_BYTES = 65_537;

interface BodyProbe {
  cancelCalls: number;
  readerCalls: number;
}

function client(centralApiUrl: string, injectedFetch?: typeof fetch): CentralEnrollmentClient {
  return new CentralEnrollmentClient({
    centralApiUrl,
    tokenProfile: TOKEN_PROFILE,
    deadlineMs: 10_000,
    ...(injectedFetch === undefined ? {} : { fetch: injectedFetch }),
  });
}

function injectedResponse(
  status: number,
  headers: Readonly<Record<string, string>>,
  probe: BodyProbe,
): Response {
  const pending = new Promise<never>(() => undefined);
  return {
    status,
    headers: new Headers(headers),
    body: {
      cancel: async () => {
        probe.cancelCalls += 1;
      },
      getReader: () => {
        probe.readerCalls += 1;
        return {
          cancel: async () => {
            probe.cancelCalls += 1;
          },
          read: async () => await pending,
        };
      },
    },
  } as unknown as Response;
}

async function rejectsWithin(
  operation: Promise<unknown>,
  controller: AbortController,
  code: string,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("enrollment waited for a response body after its headers were decisive"));
    }, 500);
    timer.unref();
  });
  try {
    await assert.rejects(Promise.race([operation, timeout]), (error: unknown) => {
      assert.ok(error instanceof CentralEnrollmentError);
      assert.equal(error.code, code);
      return true;
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function nativeFailure(
  t: TestContext,
  plan: T03ResponsePlan,
  route: "register" | "verify",
  code: string,
): Promise<void> {
  const api = await startT03ScriptedCentralApi(t, [plan]);
  const controller = new AbortController();
  const enrollment = client(api.url);
  const operation =
    route === "verify"
      ? enrollment.verify({ email: T03_EMAIL, code: T03_CODE }, controller.signal)
      : enrollment.register({ email: T03_EMAIL, username: T03_USERNAME }, controller.signal);
  await rejectsWithin(operation, controller, code);
  assert.equal(api.requests.length, 1);
  const request = api.requests[0];
  assert.ok(request !== undefined);
  await waitForT03Observation(request.connectionClosed);
  assert.equal(
    request.responseFinished(),
    false,
    "decisive headers still drained the response body",
  );
}

async function injectedFailure(
  status: number,
  headers: Readonly<Record<string, string>>,
  route: "register" | "verify",
  code: string,
): Promise<void> {
  const probe: BodyProbe = { cancelCalls: 0, readerCalls: 0 };
  const injectedFetch = (async () => injectedResponse(status, headers, probe)) as typeof fetch;
  const controller = new AbortController();
  const enrollment = client("https://central.invalid", injectedFetch);
  const operation =
    route === "verify"
      ? enrollment.verify({ email: T03_EMAIL, code: T03_CODE }, controller.signal)
      : enrollment.register({ email: T03_EMAIL, username: T03_USERNAME }, controller.signal);
  await rejectsWithin(operation, controller, code);
  assert.equal(probe.readerCalls, 0, "decisive headers opened the injected response reader");
  assert.equal(probe.cancelCalls, 1, "decisive headers did not discard the injected body");
}

test("native enrollment classifies decisive headers before oversized or held bodies", async (t) => {
  await t.test("missing verification no-store precedes an oversized body", async (subtest) => {
    await nativeFailure(
      subtest,
      {
        status: 400,
        headers: { "content-length": String(OVERSIZED_BYTES), "content-type": "application/json" },
        hold: true,
      },
      "verify",
      "central_verification_response_unsafe",
    );
  });
  await t.test("redirect precedes an oversized body", async (subtest) => {
    await nativeFailure(
      subtest,
      {
        status: 307,
        headers: { "content-length": String(OVERSIZED_BYTES), location: "/not-followed" },
        hold: true,
      },
      "register",
      "central_enrollment_outcome_uncertain",
    );
  });
  await t.test("redirect does not wait for a held body", async (subtest) => {
    await nativeFailure(
      subtest,
      { status: 302, headers: { location: "/not-followed" }, hold: true },
      "register",
      "central_enrollment_outcome_uncertain",
    );
  });
});

test("injected enrollment classifies decisive headers before oversized or held bodies", async (t) => {
  await t.test("missing verification no-store precedes an oversized body", async () => {
    await injectedFailure(
      400,
      { "content-length": String(OVERSIZED_BYTES), "content-type": "application/json" },
      "verify",
      "central_verification_response_unsafe",
    );
  });
  await t.test("redirect precedes an oversized body", async () => {
    await injectedFailure(
      307,
      { "content-length": String(OVERSIZED_BYTES), location: "/not-followed" },
      "register",
      "central_enrollment_outcome_uncertain",
    );
  });
  await t.test("redirect does not wait for a held body", async () => {
    await injectedFailure(
      302,
      { location: "/not-followed" },
      "register",
      "central_enrollment_outcome_uncertain",
    );
  });
});
