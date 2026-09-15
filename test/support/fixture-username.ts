import { createHash } from "node:crypto";
export function fixtureUsername(email: string): string {
  return `fixture${createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 20)}`;
}
