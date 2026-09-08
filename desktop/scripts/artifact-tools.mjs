import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

export async function sha256(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
function inside(root, path) {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
export async function inventory(directory, limits = {}) {
  const root = await realpath(directory);
  const entries = [];
  let total = 0;
  const maximumEntries = limits.maximumEntries ?? 100000;
  const maximumBytes = limits.maximumBytes ?? 4 * 1024 ** 3;
  async function walk(path, depth) {
    if (depth > 40) throw new Error("Package directory nesting exceeds the limit.");
    for (const name of (await readdir(path)).sort()) {
      if (
        entries.length >= maximumEntries ||
        name.includes("\\") ||
        [...name].some((character) => character.charCodeAt(0) < 32)
      )
        throw new Error("Invalid package entry.");
      const target = join(path, name);
      const stat = await lstat(target);
      const key = relative(root, target).split(sep).join("/");
      if (stat.isSymbolicLink()) {
        if (!inside(root, await realpath(target)))
          throw new Error("Package link escapes its root.");
        const link = await readlink(target);
        if (isAbsolute(link)) throw new Error("Package link must remain portable.");
        entries.push({ path: key, type: "link", target: link.split(sep).join("/") });
      } else if (stat.isDirectory()) {
        entries.push({ path: key, type: "directory" });
        await walk(target, depth + 1);
      } else if (stat.isFile()) {
        total += stat.size;
        if (total > maximumBytes) throw new Error("Package size exceeds the limit.");
        entries.push({
          path: key,
          type: "file",
          bytes: stat.size,
          executable: (stat.mode & 0o111) !== 0,
          sha256: await sha256(target),
        });
      } else throw new Error("Package contains a special file.");
    }
  }
  await walk(root, 0);
  return { schema: 1, bytes: total, entries };
}
export async function verifyInventory(root, expected) {
  if (!isDeepStrictEqual(await inventory(root), expected))
    throw new Error("Package integrity check failed.");
}
export async function dependencyBom(root, manifest, versions) {
  const components = new Map();
  for (const entry of manifest.entries) {
    if (
      entry.type !== "file" ||
      !/(^|\/)package\.json$/u.test(entry.path) ||
      entry.bytes > 512 * 1024
    )
      continue;
    let value;
    try {
      value = JSON.parse(await readFile(join(root, entry.path), "utf8"));
    } catch {
      continue;
    }
    if (
      typeof value.name !== "string" ||
      typeof value.version !== "string" ||
      value.name.length > 256 ||
      value.version.length > 128
    )
      continue;
    const scoped = value.name.startsWith("@") && value.name.includes("/");
    const name = scoped ? value.name.slice(value.name.indexOf("/") + 1) : value.name;
    const group = scoped ? value.name.slice(0, value.name.indexOf("/")) : undefined;
    const purl = `pkg:npm/${group ? `${encodeURIComponent(group)}/` : ""}${encodeURIComponent(name)}@${encodeURIComponent(value.version)}`;
    components.set(purl, {
      type: "library",
      name,
      ...(group ? { group } : {}),
      version: value.version,
      purl,
      ...(typeof value.license === "string" && value.license.length <= 256
        ? { licenses: [{ license: { name: value.license } }] }
        : {}),
    });
  }
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: { type: "application", name: "Embassys", version: versions.app },
    },
    components: [
      { type: "framework", name: "Electron", version: versions.electron },
      { type: "platform", name: "Node.js", version: versions.node },
      ...[...components.values()].sort((a, b) => a.purl.localeCompare(b.purl)),
    ],
  };
}
export function signingOptions(platform, environment) {
  const requested = environment.EMBASSYS_DESKTOP_SIGN;
  if (requested !== undefined && requested !== "1")
    throw new Error("Signing mode must be explicitly set to 1 or omitted.");
  if (!requested) {
    if (platform === "darwin")
      return {
        signed: false,
        adHocSigned: true,
        options: {
          osxSign: {
            identity: "-",
            identityValidation: false,
            continueOnError: false,
            preEmbedProvisioningProfile: false,
            preAutoEntitlements: false,
            optionsForFile: () => ({ hardenedRuntime: false }),
          },
          osxNotarize: false,
        },
      };
    return { signed: false, options: { osxSign: false, osxNotarize: false } };
  }
  const bounded = (value) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length < 256 &&
    [...value].every((character) => character.charCodeAt(0) >= 32);
  if (platform === "darwin") {
    const identity = environment.EMBASSYS_MAC_IDENTITY;
    const keychainProfile = environment.EMBASSYS_NOTARY_PROFILE;
    if (
      !bounded(identity) ||
      !identity.startsWith("Developer ID Application:") ||
      !bounded(keychainProfile)
    )
      throw new Error(
        "Signed Mac packaging needs a Developer ID identity and existing notary keychain profile.",
      );
    return {
      signed: true,
      options: {
        osxSign: {
          identity,
          continueOnError: false,
          optionsForFile: () => ({ hardenedRuntime: true }),
        },
        osxNotarize: { keychainProfile },
      },
    };
  }
  if (platform === "win32") {
    const thumbprint = environment.EMBASSYS_WINDOWS_CERTIFICATE_SHA1;
    if (typeof thumbprint !== "string" || !/^[a-fA-F0-9]{40}$/u.test(thumbprint))
      throw new Error("Signed Windows packaging needs an installed certificate thumbprint.");
    return {
      signed: true,
      options: {
        windowsSign: {
          automaticallySelectCertificate: false,
          signWithParams: [
            "/sha1",
            thumbprint,
            "/fd",
            "SHA256",
            "/tr",
            "http://timestamp.digicert.com",
            "/td",
            "SHA256",
          ],
          hashes: ["sha256"],
        },
      },
    };
  }
  throw new Error("Linux artifact signing requires a configured release-signing policy.");
}
