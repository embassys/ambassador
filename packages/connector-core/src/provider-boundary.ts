import { CONNECTOR_LIMITS, connectorError } from "./constants.js";

const POSIX_ALLOWLIST = ["HOME", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TZ"];
const DARWIN_ALLOWLIST = [...POSIX_ALLOWLIST, "__CF_USER_TEXT_ENCODING"];
const WINDOWS_ALLOWLIST = [
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "PATH",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMDATA",
  "LANG",
];
const CREDENTIAL_NAME =
  /^(?:A2A_)|(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIAL)/iu;

export function buildProviderChildEnvironment(
  platform: "linux" | "darwin" | "win32",
  inherited: Readonly<Record<string, string | undefined>>,
  webhookTokenEnvironmentName: string,
): Record<string, string> {
  const allowlist =
    platform === "darwin"
      ? DARWIN_ALLOWLIST
      : platform === "win32"
        ? WINDOWS_ALLOWLIST
        : POSIX_ALLOWLIST;
  const result: Record<string, string> = {};
  for (const name of allowlist) {
    if (name === webhookTokenEnvironmentName || CREDENTIAL_NAME.test(name)) continue;
    const value = inherited[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

export async function consumeProviderOutput(
  _stream: "stdout" | "stderr",
  chunks: AsyncIterable<Uint8Array>,
): Promise<number> {
  let bytes = 0;
  for await (const chunk of chunks) {
    bytes += chunk.byteLength;
    if (bytes > CONNECTOR_LIMITS.providerOutputBytes) {
      connectorError("connector_provider_output_limit");
    }
  }
  return bytes;
}
