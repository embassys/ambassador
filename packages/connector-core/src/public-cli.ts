import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, normalize, parse, sep } from "node:path";

import { type ConnectorPolicy, connectorError } from "./constants.js";

export type ParsedConnectorArguments =
  | {
      command: "start";
      webhookPort: number;
      webhookTokenEnvironmentName: string;
      workingDirectory: string;
      policy: ConnectorPolicy;
    }
  | { command: "retire-state" };

function scalarString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function canonicalDirectory(value: string): string {
  if (!scalarString(value) || !isAbsolute(value)) connectorError("invalid_connector_arguments");
  let metadata: ReturnType<typeof lstatSync>;
  let resolved: string;
  try {
    metadata = lstatSync(value);
    resolved = realpathSync.native(value);
  } catch {
    connectorError("invalid_connector_arguments");
  }
  if (metadata.isSymbolicLink() || !statSync(resolved).isDirectory()) {
    connectorError("invalid_connector_arguments");
  }
  if (process.platform === "win32") {
    connectorError("invalid_connector_arguments");
  }
  const normalized = normalize(value);
  const withoutTrailing = normalized === sep ? normalized : normalized.replace(/\/+$/u, "");
  if (withoutTrailing !== resolved || parse(resolved).root === "") {
    connectorError("invalid_connector_arguments");
  }
  return resolved;
}

export function parseConnectorArguments(arguments_: readonly string[]): ParsedConnectorArguments {
  if (
    arguments_.length === 2 &&
    arguments_[0] === "retire-state" &&
    arguments_[1] === "--confirm=retire-all-correlation"
  ) {
    return { command: "retire-state" };
  }
  if (arguments_.length !== 5 || arguments_[0] !== "start") {
    connectorError("invalid_connector_arguments");
  }
  const accepted = new Map<string, string>();
  for (const argument of arguments_.slice(1)) {
    const match = /^(--webhook-port|--webhook-token-env|--working-directory|--policy)=(.*)$/su.exec(
      argument,
    );
    if (match?.[1] === undefined || match[2] === "" || accepted.has(match[1])) {
      connectorError("invalid_connector_arguments");
    }
    const value = match[2];
    if (value === undefined) connectorError("invalid_connector_arguments");
    accepted.set(match[1], value);
  }
  if (accepted.size !== 4) connectorError("invalid_connector_arguments");
  const portText = accepted.get("--webhook-port");
  const tokenName = accepted.get("--webhook-token-env");
  const directory = accepted.get("--working-directory");
  const policy = accepted.get("--policy");
  if (
    portText === undefined ||
    !/^(?:[1-9][0-9]{3,4})$/u.test(portText) ||
    Number(portText) < 1_024 ||
    Number(portText) > 65_535 ||
    Number(portText) === 8_787 ||
    tokenName === undefined ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(tokenName) ||
    directory === undefined ||
    (policy !== "read-only" && policy !== "workspace-write")
  ) {
    connectorError("invalid_connector_arguments");
  }
  return {
    command: "start",
    webhookPort: Number(portText),
    webhookTokenEnvironmentName: tokenName,
    workingDirectory: canonicalDirectory(directory),
    policy,
  };
}

export function enforcePolicyCeiling(
  maximum: ConnectorPolicy,
  effective: ConnectorPolicy,
): ConnectorPolicy {
  if (maximum === "read-only" && effective !== "read-only") {
    connectorError("connector_policy_exceeded");
  }
  if (maximum !== "read-only" && maximum !== "workspace-write") {
    connectorError("connector_policy_exceeded");
  }
  if (effective !== "read-only" && effective !== "workspace-write") {
    connectorError("connector_policy_exceeded");
  }
  return effective;
}
