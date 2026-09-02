import {
  type CentralCredentialRecord,
  createCentralCredentialRecord,
  serializeCentralCredential,
} from "../../src/central-credential.js";
import { generateDpopKeyMaterial } from "../../src/dpop.js";

export const FIXTURE_NOW_SECONDS = 1_788_220_800;

export function currentCredentialRecord(
  email = "credential@fixture.test",
  subject = "agent.fixture",
  now = FIXTURE_NOW_SECONDS,
): CentralCredentialRecord {
  const key = generateDpopKeyMaterial();
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8").toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      sub: subject,
      email,
      iat: now,
      exp: now + 30 * 24 * 60 * 60,
      cnf: { jkt: key.thumbprint },
    }),
    "utf8",
  ).toString("base64url");
  return createCentralCredentialRecord(`${header}.${payload}.fixture-signature`, key);
}

export function currentCredential(
  email = "credential@fixture.test",
  subject = "agent.fixture",
  now = FIXTURE_NOW_SECONDS,
): string {
  return serializeCentralCredential(currentCredentialRecord(email, subject, now));
}
