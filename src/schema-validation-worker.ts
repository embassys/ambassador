import { parentPort, workerData } from "node:worker_threads";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";

const single = new Set([
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "contains",
  "additionalItems",
  "unevaluatedItems",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
]);
const maps = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);
const arrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Central uses jsonschema without FormatChecker. Remove that annotation only
 * at schema positions, preserving property names, enum values and defaults. */
function centralSchema(value: unknown, depth = 0): unknown {
  if (depth > 128) throw new Error("Schema depth exceeded");
  if (!record(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "format") continue;
    if (single.has(key)) result[key] = centralSchema(item, depth + 1);
    else if (maps.has(key) && record(item))
      result[key] = Object.fromEntries(
        Object.entries(item).map(([name, child]) => [name, centralSchema(child, depth + 1)]),
      );
    else if ((arrays.has(key) || key === "items") && Array.isArray(item))
      result[key] = item.map((child) => centralSchema(child, depth + 1));
    else if (key === "items") result[key] = centralSchema(item, depth + 1);
    else if (key === "dependencies" && record(item))
      result[key] = Object.fromEntries(
        Object.entries(item).map(([name, child]) => [
          name,
          Array.isArray(child) ? child : centralSchema(child, depth + 1),
        ]),
      );
    else result[key] = item;
  }
  return result;
}
try {
  const schema = centralSchema(workerData.schema) as Record<string, unknown>;
  const validate = new CfWorkerJsonSchemaValidator().getValidator(schema);
  parentPort?.postMessage(validate(workerData.payload).valid);
} catch {
  parentPort?.postMessage("unsupported");
}
