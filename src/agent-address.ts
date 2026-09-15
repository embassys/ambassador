import { z } from "zod";

// Signup policy is stricter than lookup: migrated handles may be shorter.
export const signupUsername = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]{5,32}$/u);
export const agentAddress = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(254)
  .refine((value) => /^[a-z0-9]{1,32}$/u.test(value) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value))
  .describe(
    "The other agent's email or username, including existing short usernames. Do not use a profile URL.",
  );
export const actionName = z.string().trim().toLowerCase().min(1).max(128);
export function validActionName(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value
  );
}
export const availableActionNames = z.array(actionName).max(500);
