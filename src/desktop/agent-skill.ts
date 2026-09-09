import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { secureWindowsArtifact } from "../windows-access-control.js";
import { type ConnectionProvider, readBoundedConfiguration } from "./agent-connections.js";

export function agentSkillPath(
  provider: ConnectionProvider,
  configuration: string,
  home: string,
): string {
  if (!isAbsolute(configuration) || !isAbsolute(home)) throw new Error("Invalid skill location.");
  const root =
    provider === "codex"
      ? join(home, ".agents")
      : provider === "claude_code" && dirname(configuration) === home
        ? join(home, ".claude")
        : dirname(configuration);
  return join(root, "skills", "embassys", "SKILL.md");
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const ownerSchema = z.strictObject({
  version: z.literal(1),
  path: z.string().max(4096),
  hash: z.string().regex(/^[a-f0-9]{64}$/u),
  previousHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  removed: z.boolean(),
});
export interface SkillState {
  state: "installed" | "missing" | "conflict";
  owned: boolean;
  message: string;
}
const conflict: SkillState = {
  state: "conflict",
  owned: false,
  message:
    "The Embassys skill has different content or an unsupported location. Your files were kept; review the skill before connecting.",
};

/** Own only one reviewed skill file. An identical manually installed skill stays unowned. */
export class AgentSkill {
  constructor(readonly options: { path: string; ownershipPath: string; content: string }) {
    if (
      ![options.path, options.ownershipPath].every(isAbsolute) ||
      Buffer.byteLength(options.content) > 32768 ||
      !options.content.startsWith("---\nname: embassys\n")
    )
      throw new Error("Invalid Embassys skill.");
  }
  async #read() {
    // The provider root is trusted configuration; nested skill directories cannot redirect writes.
    for (const directory of [dirname(dirname(this.options.path)), dirname(this.options.path)]) {
      try {
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error("Linked skill directory.");
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
          throw error;
      }
    }
    const current = await readBoundedConfiguration(this.options.path, 32768);
    const saved = await readBoundedConfiguration(this.options.ownershipPath, 8192);
    const owner =
      saved.fingerprint === "absent"
        ? undefined
        : ownerSchema.parse(JSON.parse(saved.bytes.toString("utf8")));
    if (owner && owner.path !== this.options.path) throw new Error("Wrong skill ownership.");
    const owned = Boolean(owner && !owner.removed);
    const currentHash = current.fingerprint === "absent" ? undefined : hash(current.bytes);
    if (
      currentHash &&
      (owned
        ? ![owner?.hash, owner?.previousHash].includes(currentHash)
        : currentHash !== hash(this.options.content))
    )
      throw new Error("Skill changed.");
    return { current, owner, owned };
  }
  async inspect(): Promise<SkillState> {
    try {
      const { current, owned } = await this.#read();
      return {
        state: current.fingerprint === "absent" ? "missing" : "installed",
        owned,
        message:
          current.fingerprint === "absent"
            ? "Embassys discovery skill is missing."
            : "Embassys discovery skill is installed.",
      };
    } catch {
      return conflict;
    }
  }
  async #write(path: string, bytes: string, expected: string) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        if (process.platform === "win32") await secureWindowsArtifact(temporary, "file");
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      if ((await readBoundedConfiguration(path, 32768)).fingerprint !== expected)
        throw new Error("Skill changed during setup.");
      if (expected === "absent") await link(temporary, path);
      else await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async #save(removed: boolean, previousHash?: string) {
    const path = this.options.ownershipPath;
    const saved = await readBoundedConfiguration(path, 8192);
    await this.#write(
      path,
      JSON.stringify({
        version: 1,
        path: this.options.path,
        hash: hash(this.options.content),
        ...(previousHash ? { previousHash } : {}),
        removed,
      }),
      saved.fingerprint,
    );
  }
  async install(): Promise<SkillState> {
    try {
      const before = await this.#read();
      if (before.current.bytes.toString("utf8") === this.options.content) return this.inspect();
      await this.#save(
        false,
        before.owner && !before.owner.removed ? before.owner.hash : undefined,
      );
      await this.#read();
      await this.#write(this.options.path, this.options.content, before.current.fingerprint);
      await this.#save(false);
      return this.inspect();
    } catch {
      return conflict;
    }
  }
  async remove(): Promise<SkillState> {
    try {
      const before = await this.#read();
      if (!before.owned) return this.inspect();
      if ((await this.#read()).current.fingerprint !== before.current.fingerprint) return conflict;
      await rm(this.options.path, { force: true });
      await this.#save(true);
      return this.inspect();
    } catch {
      return conflict;
    }
  }
}
