import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { secureWindowsArtifact } from "../windows-access-control.js";

export const appearanceSchema = z.enum(["system", "light", "dark"]);
export type Appearance = z.infer<typeof appearanceSchema>;
const settings = z.strictObject({ appearance: appearanceSchema });

export function windowAppearance(platform: string, dark: boolean, reducedTransparency: boolean) {
  return {
    backgroundColor: dark ? "#1e1e20" : "#f5f5f7",
    titleBarStyle: platform === "darwin" ? ("hiddenInset" as const) : ("default" as const),
    ...(platform === "darwin" && !reducedTransparency
      ? { vibrancy: "sidebar" as const, visualEffectState: "followWindow" as const }
      : {}),
    ...(platform === "win32" && !reducedTransparency
      ? { backgroundMaterial: "mica" as const }
      : {}),
  };
}

export class DesktopAppearance {
  #value: Appearance;
  private constructor(
    readonly directory: string,
    value: Appearance,
  ) {
    this.#value = value;
  }
  get value(): Appearance {
    return this.#value;
  }
  static async open(directory: string): Promise<DesktopAppearance> {
    let value: Appearance = "system";
    try {
      const path = join(directory, "appearance.json");
      const stat = await lstat(path);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024)
        throw new Error("Invalid appearance settings.");
      const file = await open(
        path,
        constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      );
      try {
        const bytes = Buffer.alloc(1025);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > 1024) throw new Error("Invalid appearance settings.");
        value = settings.parse(
          JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")),
        ).appearance;
      } finally {
        await file.close();
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        throw error;
    }
    return new DesktopAppearance(directory, value);
  }
  async set(input: Appearance): Promise<void> {
    const value = appearanceSchema.parse(input);
    const temporary = join(this.directory, `appearance-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      if (process.platform === "win32") await secureWindowsArtifact(temporary, "file");
      await file.writeFile(JSON.stringify({ appearance: value }));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, join(this.directory, "appearance.json"));
    } finally {
      await rm(temporary, { force: true });
    }
    this.#value = value;
  }
}
