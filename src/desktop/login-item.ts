import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

const loginName = "com.embassys.desktop.development";
export interface LoginItemState {
  readonly canChange: boolean;
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly message: string;
}
interface LoginOptions {
  path?: string;
  args?: string[];
  name?: string;
  openAtLogin?: boolean;
}
interface NativeLoginItems {
  read(options: LoginOptions): {
    openAtLogin: boolean;
    executableWillLaunchAtLogin?: boolean;
    launchItems?: { name: string; path: string; args: string[]; enabled: boolean }[];
    status?: string;
  };
  write(options: LoginOptions): void;
}

/** Desktop Entry string escaping followed by Exec argument escaping. No shell. */
export function linuxLoginEntry(executable: string): string {
  if (
    !executable.startsWith("/") ||
    executable.length > 4096 ||
    executable.includes("=") ||
    [...executable].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("This application path cannot be registered for startup.");
  const argument = executable
    .replace(/[\\"`$]/gu, "\\$&")
    .replace(/\\/gu, "\\\\")
    .replace(/%/gu, "%%");
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    "Name=Embassys",
    "Comment=Run your enabled Embassys servers in the background",
    `Exec="${argument}" --background`,
    "Terminal=false",
    "StartupNotify=false",
    `X-Embassys-Owner=${loginName}`,
    "",
  ].join("\n");
}

export class DesktopLoginItem {
  #tail: Promise<unknown> = Promise.resolve();
  constructor(
    readonly options: {
      platform: NodeJS.Platform;
      packaged: boolean;
      executable: string;
      configurationDirectory?: string;
      macDistributionVerified?: boolean;
      native?: NativeLoginItems;
    },
  ) {}

  #unavailable(message: string): LoginItemState {
    return { canChange: false, configured: false, enabled: false, message };
  }

  #unsupported(): LoginItemState | undefined {
    if (!this.options.packaged)
      return this.#unavailable("Launch at login requires the installed app.");
    if (this.options.platform === "darwin" && !this.options.macDistributionVerified)
      return this.#unavailable(
        "Launch at login requires a verified signed and notarized Mac build. This app has not passed that check.",
      );
    if (!["darwin", "win32", "linux"].includes(this.options.platform))
      return this.#unavailable("Launch at login is unavailable on this system.");
    return undefined;
  }

  #nativeOptions(): LoginOptions {
    return this.options.platform === "win32"
      ? { path: this.options.executable, args: ["--background"] }
      : {};
  }

  #linuxPath(): string {
    const root = this.options.configurationDirectory;
    if (!root || !isAbsolute(root)) throw new Error("The startup directory is unavailable.");
    return join(root, "autostart", `${loginName}.desktop`);
  }

  async #linuxContents(): Promise<string | undefined> {
    const path = this.#linuxPath();
    try {
      const before = await lstat(path);
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size > 8192 ||
        (process.getuid && before.uid !== process.getuid())
      )
        throw new Error("Unmanaged startup entry.");
      const file = await open(
        path,
        constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      );
      try {
        const current = await file.stat();
        if (current.ino !== before.ino || current.dev !== before.dev)
          throw new Error("Startup entry changed.");
        const buffer = Buffer.alloc(8193);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 8192) throw new Error("Startup entry exceeds the limit.");
        return buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await file.close();
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    }
  }

  async read(): Promise<LoginItemState> {
    const unsupported = this.#unsupported();
    if (unsupported) return unsupported;
    try {
      if (this.options.platform === "linux") {
        const contents = await this.#linuxContents();
        if (contents !== undefined && contents !== linuxLoginEntry(this.options.executable))
          return this.#unavailable(
            "The startup entry was changed outside Embassys. Review it in your system's startup settings.",
          );
        return {
          canChange: true,
          configured: contents !== undefined,
          enabled: contents !== undefined,
          message: contents
            ? "Configured for your desktop session. Your desktop may also have a startup override."
            : "Embassys will open only when you launch it.",
        };
      }
      const value = this.options.native?.read(this.#nativeOptions());
      if (!value) throw new Error("Native startup settings are unavailable.");
      const pending = value.status === "requires-approval";
      const enabled =
        this.options.platform === "win32"
          ? value.openAtLogin &&
            value.launchItems?.some(
              (item) =>
                item.name === loginName &&
                item.path.toLowerCase() === this.options.executable.toLowerCase() &&
                item.args.length === 1 &&
                item.args[0] === "--background" &&
                item.enabled,
            ) === true
          : value.openAtLogin && value.status === "enabled";
      return {
        canChange: true,
        configured: value.openAtLogin || pending,
        enabled,
        message: pending
          ? "Allow Embassys in System Settings → General → Login Items."
          : value.openAtLogin && !enabled
            ? this.options.platform === "win32"
              ? "Startup is disabled or unavailable in Windows startup settings."
              : "Startup is disabled or unavailable in System Settings."
            : enabled
              ? "Enabled servers will start in the background when you sign in."
              : "Embassys will open only when you launch it.",
      };
    } catch {
      return this.#unavailable(
        "Startup settings could not be read. Check your system's startup settings.",
      );
    }
  }

  set(enabled: boolean): Promise<LoginItemState> {
    const result = this.#tail.then(async () => {
      if (!(await this.read()).canChange)
        throw new Error("Startup settings cannot be changed safely.");
      if (this.options.platform !== "linux") {
        this.options.native?.write({
          ...this.#nativeOptions(),
          ...(this.options.platform === "win32" ? { name: loginName } : {}),
          openAtLogin: enabled,
        });
      } else {
        const path = this.#linuxPath();
        const expected = linuxLoginEntry(this.options.executable);
        const current = await this.#linuxContents();
        if (current !== undefined && current !== expected)
          throw new Error("The startup entry changed.");
        if (!enabled && current === undefined) return await this.read();
        if (enabled && current === undefined) {
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          const temporary = join(dirname(path), `.ambassador-startup-${randomUUID()}.tmp`);
          const file = await open(temporary, "wx", 0o600);
          try {
            try {
              await file.writeFile(expected);
              await file.sync();
            } finally {
              await file.close();
            }
            await link(temporary, path);
          } finally {
            await unlink(temporary);
          }
        } else if (!enabled && current !== undefined) {
          if ((await this.#linuxContents()) !== expected)
            throw new Error("The startup entry changed.");
          await unlink(path);
        }
        if (process.platform !== "win32") {
          const directory = await open(dirname(path), constants.O_RDONLY);
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        }
      }
      return await this.read();
    });
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
