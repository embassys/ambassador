import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { secureWindowsArtifact } from "../windows-access-control.js";

export const appearanceSchema = z.enum(["system", "light", "dark"]);
export type Appearance = z.infer<typeof appearanceSchema>;
const settings = z.strictObject({ appearance: appearanceSchema });

type RGB = [number, number, number];
function luminance(rgb: RGB): number {
  const weights: RGB = [0.2126, 0.7152, 0.0722];
  return weights.reduce((sum, weight, index) => {
    const channel = rgb[index] ?? 0;
    const value = channel / 255;
    const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    return sum + linear * weight;
  }, 0);
}
function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function hex(rgb: RGB): string {
  return `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/** Electron supplies RGBA; only opaque system colours enter the renderer. */
export function controlPalette(rawAccent: string | undefined, dark: boolean) {
  const accent = rawAccent && /^[0-9a-f]{6}ff$/i.test(rawAccent) ? rawAccent : "007affff";
  const rgb = [0, 2, 4].map((offset) =>
    Number.parseInt(accent.slice(offset, offset + 2), 16),
  ) as RGB;
  const brightness = luminance(rgb);
  const accentText = contrast(brightness, 1) >= contrast(brightness, 0) ? "#ffffff" : "#000000";
  const background = luminance(dark ? [41, 41, 44] : [245, 245, 247]);
  let link = rgb;
  // Preserve the accent hue while bringing link contrast above 4.5:1.
  for (let step = 1; contrast(luminance(link), background) < 4.5 && step <= 20; step++) {
    link = rgb.map((channel) =>
      Math.round(channel + (((dark ? 255 : 0) - channel) * step) / 20),
    ) as RGB;
  }
  return { accent: hex(rgb), accentText, link: hex(link) };
}

export function windowAppearance(platform: string, dark: boolean, reducedTransparency: boolean) {
  return {
    backgroundColor:
      platform === "darwin" && !reducedTransparency ? "#00000000" : dark ? "#1e1e20" : "#f5f5f7",
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
