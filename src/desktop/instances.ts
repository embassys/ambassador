import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { secureWindowsArtifact } from "../windows-access-control.js";
import { type DesktopInstance, desktopInstanceSchema } from "./protocol.js";

const registrySchema = z.strictObject({
  version: z.literal(1),
  instances: z.array(desktopInstanceSchema).max(8),
});

function overlaps(left: string, right: string): boolean {
  const a = process.platform === "win32" ? left.toLowerCase() : left;
  const b = process.platform === "win32" ? right.toLowerCase() : right;
  const contained = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
  };
  return contained(a, b) || contained(b, a);
}

async function secureDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()))
    throw new Error("Choose a private directory owned by you.");
  if (process.platform === "win32") await secureWindowsArtifact(path, "directory");
  else await chmod(path, 0o700);
  return await realpath(path);
}

export class DesktopInstances {
  #instances: DesktopInstance[];
  #tail: Promise<unknown> = Promise.resolve();
  private constructor(
    readonly directory: string,
    records: DesktopInstance[],
  ) {
    this.#instances = records;
  }

  static async open(directory: string): Promise<DesktopInstances> {
    const canonical = await secureDirectory(resolve(directory));
    const path = join(canonical, "instances.json");
    let records: DesktopInstance[] = [];
    try {
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > 64 * 1024 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new Error("Invalid instance registry.");
      const file = await open(
        path,
        constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      );
      try {
        records = registrySchema.parse(JSON.parse(await file.readFile("utf8"))).instances;
      } finally {
        await file.close();
      }
      const ids = new Set<string>();
      const ports = new Set<number>();
      const roots: string[] = [];
      for (const record of records) {
        if (!isAbsolute(record.stateDirectory) || !isAbsolute(record.workingDirectory))
          throw new Error("Invalid instance path.");
        const root = await realpath(record.stateDirectory);
        const stat = await lstat(record.stateDirectory);
        if (!stat.isDirectory() || basename(root) !== record.id || root !== record.stateDirectory)
          throw new Error("Invalid instance storage binding.");
        if (
          ids.has(record.id) ||
          ports.has(record.port) ||
          roots.some((other) => overlaps(other, root))
        )
          throw new Error("Instance registry contains conflicting instances.");
        if (
          (await realpath(dirname(record.workingDirectory))) !== root ||
          record.workingDirectory !== join(record.stateDirectory, "workspace")
        )
          throw new Error("Invalid instance workspace.");
        ids.add(record.id);
        ports.add(record.port);
        roots.push(root);
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        throw error;
      // A missing registry is first launch; a missing registered directory is corruption.
      if (records.length > 0)
        throw new Error("An instance directory is missing. Restore it before continuing.");
    }
    return new DesktopInstances(canonical, records);
  }

  list(): DesktopInstance[] {
    return this.#instances.map((instance) => ({ ...instance }));
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  async #save(records: DesktopInstance[]): Promise<void> {
    const bytes = JSON.stringify(registrySchema.parse({ version: 1, instances: records }), null, 2);
    if (Buffer.byteLength(bytes) > 64 * 1024) throw new Error("Instance registry is full.");
    const path = join(this.directory, "instances.json");
    const temporary = join(this.directory, `.instances-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      if (process.platform === "win32") await secureWindowsArtifact(temporary, "file");
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, path);
      if (process.platform !== "win32") {
        const directory = await open(this.directory, constants.O_RDONLY);
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
    this.#instances = records;
  }

  create(input: {
    name: string;
    port: number;
    parentDirectory?: string;
    requestId?: string;
  }): Promise<DesktopInstance> {
    return this.#serial(async () => {
      const previous = this.#instances.find((item) => item.id === input.requestId);
      if (previous) {
        const expectedParent = await realpath(
          input.parentDirectory ?? join(this.directory, "instances"),
        );
        if (
          previous.name !== input.name.trim() ||
          previous.port !== input.port ||
          dirname(previous.stateDirectory) !== expectedParent
        )
          throw new Error("This creation request was already used for a different instance.");
        return { ...previous };
      }
      if (this.#instances.length >= 8)
        throw new Error("This build supports up to eight instances.");
      if (this.#instances.some((item) => item.port === input.port))
        throw new Error("Another instance uses this port.");
      const id = input.requestId ?? randomUUID();
      const parent =
        input.parentDirectory === undefined
          ? join(this.directory, "instances")
          : resolve(input.parentDirectory);
      let existingParent: string;
      if (input.parentDirectory === undefined) existingParent = await secureDirectory(parent);
      else {
        const stat = await lstat(parent);
        if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()))
          throw new Error("Choose a directory owned by you.");
        existingParent = await realpath(parent);
      }
      if (
        this.#instances.some(
          (item) =>
            overlaps(item.stateDirectory, existingParent) &&
            existingParent !== dirname(item.stateDirectory),
        )
      )
        throw new Error("Choose a location outside another instance's data.");
      const stateDirectory = join(existingParent, id);
      const workingDirectory = join(stateDirectory, "workspace");
      const instance = desktopInstanceSchema.parse({
        id,
        name: input.name,
        port: input.port,
        stateDirectory,
        workingDirectory,
        enabled: true,
        createdAt: new Date().toISOString(),
      });
      await secureDirectory(stateDirectory);
      await secureDirectory(workingDirectory);
      await this.#save([...this.#instances, instance]);
      return { ...instance };
    });
  }

  updateEnabled(id: string, enabled: boolean): Promise<void> {
    return this.#serial(async () => {
      if (!this.#instances.some((item) => item.id === id)) throw new Error("Instance not found.");
      await this.#save(
        this.#instances.map((item) => (item.id === id ? { ...item, enabled } : item)),
      );
    });
  }
}
