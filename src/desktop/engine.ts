import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const BUNDLED_NODE_VERSION = "24.19.0";

/** Source integrity is independent of platform code-signing changes to binaries. */
export async function engineSourceDigest(directory: string): Promise<string> {
  const hash = createHash("sha256");
  let count = 0;
  let bytes = 0;
  async function visit(path: string, relative: string, depth: number): Promise<void> {
    const stat = await lstat(path);
    if (++count > 10000 || depth > 20 || stat.isSymbolicLink())
      throw new Error("Invalid bundled engine source.");
    if (stat.isDirectory()) {
      hash.update(`directory:${relative}\0`);
      for (const name of (await readdir(path)).sort())
        await visit(join(path, name), `${relative}/${name}`, depth + 1);
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > 64 * 1024 * 1024 || stat.size > 8 * 1024 * 1024)
        throw new Error("Bundled engine source exceeds its limit.");
      const digest = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
      hash.update(`file:${relative}\0${stat.size}\0${digest}\0`);
    } else throw new Error("Invalid bundled engine source entry.");
  }
  await visit(directory, "", 0);
  return hash.digest("hex");
}

const version = z.string().regex(/^\d+\.\d+\.\d+$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const buildManifest = z.strictObject({
  app: version,
  core: version,
  node: z.literal(BUNDLED_NODE_VERSION),
  electron: version,
  runtimeSha256: digest,
  platform: z.string().max(20),
  arch: z.string().max(20),
  protocol: z.literal(1),
  source: digest,
  qualification: z.string().max(256),
});

async function readMetadata(path: string): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("Invalid engine metadata.");
  return JSON.parse(await readFile(path, "utf8"));
}

export async function verifyBundledEngine(options: {
  manifestPath: string;
  gateway: string;
  app: string;
  electron: string;
  platform: string;
  arch: string;
}): Promise<z.infer<typeof buildManifest>> {
  const manifest = buildManifest.parse(await readMetadata(options.manifestPath));
  const core = z
    .object({ version })
    .parse(await readMetadata(join(options.gateway, "package.json")));
  if (
    manifest.app !== options.app ||
    manifest.electron !== options.electron ||
    manifest.platform !== options.platform ||
    manifest.arch !== options.arch ||
    manifest.core !== core.version
  )
    throw new Error("The bundled engine is incompatible with this app.");
  if (manifest.source !== (await engineSourceDigest(join(options.gateway, "dist"))))
    throw new Error("The bundled engine failed its source integrity check.");
  return manifest;
}
