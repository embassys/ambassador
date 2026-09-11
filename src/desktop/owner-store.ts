import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { EncryptedFileCredentialStore } from "../credential-store.js";
import { ProcessLock } from "../process-lock.js";
import { secureWindowsArtifact } from "../windows-access-control.js";
import { deriveCredentialKeyIsolated } from "./credential-kdf.js";
import { readLocalSettings, writeLocalSettings } from "./local-settings.js";
import { ownerEmail, ownerIssue, publicOwnerProfile } from "./owner-protocol.js";

const credential = z.strictObject({
  access: z.string().min(20).max(16384),
  refresh: z.string().min(10).max(512),
  expiresAt: z.number().int().positive(),
  agentId: z.uuid(),
  sessionId: z.uuid(),
  email: ownerEmail,
});
export type OwnerCredential = z.infer<typeof credential>;
export const ownerStateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("signed_out"), issue: ownerIssue.optional() }),
  z.strictObject({
    status: z.literal("reauth_required"),
    email: ownerEmail.optional(),
    issue: ownerIssue,
  }),
  z.strictObject({
    status: z.literal("code_sent"),
    email: ownerEmail,
    resendAt: z.number().int(),
    expiresAt: z.number().int(),
    issue: ownerIssue.optional(),
  }),
  z.strictObject({ status: z.literal("signed_in"), credential, account: publicOwnerProfile }),
]);
export type OwnerState = z.infer<typeof ownerStateSchema>;
const aad = Buffer.from("embassys-owner-session:v1:https://mcp.embassys.ai");
const envelope = z.strictObject({
  version: z.literal(1),
  iv: z.string().regex(/^[a-f0-9]{24}$/u),
  tag: z.string().regex(/^[a-f0-9]{32}$/u),
  ciphertext: z
    .string()
    .min(2)
    .max(131072)
    .regex(/^(?:[a-f0-9]{2})+$/u),
});

export class OwnerStore {
  #closed = false;
  private constructor(
    readonly directory: string,
    readonly key: Buffer,
    readonly lock: ProcessLock,
    readonly directoryIdentity: { dev: number; ino: number },
  ) {}

  static async open(directory: string): Promise<OwnerStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()))
      throw new Error("Account storage is unavailable.");
    if (process.platform === "win32") await secureWindowsArtifact(directory, "directory");
    else await chmod(directory, 0o700);
    const canonical = await realpath(directory);
    const lock = await ProcessLock.acquire(join(canonical, "owner.lock"));
    try {
      const keys = new EncryptedFileCredentialStore(
        join(canonical, "key.enc"),
        join(canonical, "key.wrap"),
        "embassys-desktop-owner-key-v1",
        {
          deriveKey: deriveCredentialKeyIsolated,
          validatePlaintext: (value) => {
            if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("Invalid account key.");
          },
        },
      );
      let key = await keys.load();
      if (!key) {
        // A missing key beside saved state is corruption, never a fresh account.
        if (
          (await readLocalSettings(join(canonical, "session.json"), envelope)) ||
          (await Promise.all(
            ["mutations.sqlite", "people.sqlite"].map((file) =>
              lstat(join(canonical, file)).then(
                () => true,
                (error: NodeJS.ErrnoException) => {
                  if (error.code === "ENOENT") return false;
                  throw error;
                },
              ),
            ),
          ).then((results) => results.some(Boolean)))
        )
          throw new Error("Account key is missing.");
        key = randomBytes(32).toString("hex");
        await keys.save(key);
      }
      return new OwnerStore(canonical, Buffer.from(key, "hex"), lock, await lstat(canonical));
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  async load(): Promise<OwnerState> {
    if (this.#closed) throw new Error("Account storage is closed.");
    await this.#checkArtifacts();
    const value = await readLocalSettings(join(this.directory, "session.json"), envelope);
    await this.#checkArtifacts();
    if (!value) return { status: "signed_out" };
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(value.iv, "hex"));
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(value.tag, "hex"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, "hex")),
      decipher.final(),
    ]);
    try {
      return ownerStateSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)),
      );
    } finally {
      plaintext.fill(0);
    }
  }

  async save(value: OwnerState): Promise<void> {
    if (this.#closed) throw new Error("Account storage is closed.");
    await this.#checkArtifacts();
    // Validate existing artifact before atomic replacement, including a sign-out.
    await readLocalSettings(join(this.directory, "session.json"), envelope);
    const plaintext = Buffer.from(JSON.stringify(ownerStateSchema.parse(value)));
    const iv = randomBytes(12);
    try {
      const cipher = createCipheriv("aes-256-gcm", this.key, iv);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      await writeLocalSettings(join(this.directory, "session.json"), {
        version: 1,
        iv: iv.toString("hex"),
        tag: cipher.getAuthTag().toString("hex"),
        ciphertext: ciphertext.toString("hex"),
      });
      await this.#checkArtifacts();
    } finally {
      plaintext.fill(0);
    }
  }

  async #checkArtifacts(): Promise<void> {
    const directory = await lstat(this.directory);
    if (
      !directory.isDirectory() ||
      directory.dev !== this.directoryIdentity.dev ||
      directory.ino !== this.directoryIdentity.ino ||
      (process.getuid && directory.uid !== process.getuid())
    )
      throw new Error("Account storage changed.");
    if (process.platform === "win32") await secureWindowsArtifact(this.directory, "directory");
    else if ((directory.mode & 0o777) !== 0o700) throw new Error("Account storage is not private.");
    const path = join(this.directory, "session.json");
    let file: Stats;
    try {
      file = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!file.isFile() || file.nlink !== 1 || (process.getuid && file.uid !== process.getuid()))
      throw new Error("Account session is not a private file.");
    if (process.platform === "win32") await secureWindowsArtifact(path, "file");
    else if ((file.mode & 0o777) !== 0o600) throw new Error("Account session is not private.");
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.key.fill(0);
    await this.lock.release();
  }
}
