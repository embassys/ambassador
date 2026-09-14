import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  randomBytes,
} from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  type CentralKeyMaterial,
  centralJwkThumbprint,
  exactCentralPublicJwk,
} from "../central-credential.js";
import { EncryptedFileCredentialStore } from "../credential-store.js";
import { generateDpopKeyMaterial } from "../dpop.js";
import { ProcessLock } from "../process-lock.js";
import { secureWindowsArtifact } from "../windows-access-control.js";
import { deriveCredentialKeyIsolated } from "./credential-kdf.js";
import { readLocalSettings, writeLocalSettings } from "./local-settings.js";
import { ownerEmail, ownerIssue, publicOwnerProfile } from "./owner-protocol.js";

const credential = z.strictObject({
  access: z.string().min(20).max(16384),
  refresh: z.string().min(10).max(512),
  expiresAt: z.number().int().positive(),
  ownerId: z.uuid(),
  deviceId: z.uuid(),
  jkt: z.string().max(128),
  sessionExpiresAt: z.number().int().positive(),
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
  z.strictObject({
    status: z.literal("signed_in"),
    credential,
    account: publicOwnerProfile,
    refreshStartedAt: z.number().int().nonnegative().optional(),
  }),
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
  #device: CentralKeyMaterial | undefined;
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
            ["mutations.sqlite", "people.sqlite", "events.sqlite", "device.enc", "device.wrap"].map(
              (file) =>
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

  async deviceKey(): Promise<CentralKeyMaterial> {
    if (this.#device) return this.#device;
    const keys = new EncryptedFileCredentialStore(
      join(this.directory, "device.enc"),
      join(this.directory, "device.wrap"),
      "embassys-owner-device-v1",
      {
        deriveKey: deriveCredentialKeyIsolated,
        validatePlaintext: (value) => {
          if (!/^[A-Za-z0-9_-]{1,1024}$/u.test(value)) throw new Error("Invalid device key");
        },
      },
    );
    let privateKeyPkcs8 = await keys.load();
    if (!privateKeyPkcs8) {
      if ((await this.load()).status === "signed_in")
        throw new Error("The signed-in device key is missing.");
      privateKeyPkcs8 = generateDpopKeyMaterial().privateKeyPkcs8;
      await keys.save(privateKeyPkcs8);
    }
    const privateKey = createPrivateKey({
      key: Buffer.from(privateKeyPkcs8, "base64url"),
      format: "der",
      type: "pkcs8",
    });
    const publicJwk = exactCentralPublicJwk(createPublicKey(privateKey).export({ format: "jwk" }));
    this.#device = {
      privateKey,
      privateKeyPkcs8,
      publicJwk,
      thumbprint: centralJwkThumbprint(publicJwk),
    };
    return this.#device;
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
      const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
      // Old app-audience credentials cannot authorize the new owner realm.
      if (raw?.status === "signed_in" && raw.credential?.agentId && !raw.credential.ownerId)
        return {
          status: "reauth_required",
          email: ownerEmail.parse(raw.credential.email),
          issue: "session_expired",
        };
      return ownerStateSchema.parse(raw);
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
