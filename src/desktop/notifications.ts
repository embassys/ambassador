import { createHash } from "node:crypto";
import { z } from "zod";
import { readLocalSettings, writeLocalSettings } from "./local-settings.js";

export const localNotificationSchema = z.strictObject({
  id: z.string().min(1).max(256),
  enrollmentId: z.string().min(1).max(256),
  kind: z.enum(["incoming", "result", "permission", "question"]),
});
export type LocalNotification = z.infer<typeof localNotificationSchema>;
const settingsSchema = z.strictObject({
  enabled: z.boolean(),
  seen: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(2000),
});
export interface NotificationBanner {
  instanceId: string;
  count: number;
  page: "attention" | "permissions";
  activity: "incoming" | "results";
}
export class DesktopNotifications {
  #settings: z.infer<typeof settingsSchema>;
  #pending = new Map<string, NotificationBanner>();
  #tail: Promise<unknown> = Promise.resolve();
  private constructor(
    readonly options: { path: string; show(banner: NotificationBanner): void },
    settings: z.infer<typeof settingsSchema>,
  ) {
    this.#settings = settings;
  }
  static async open(options: {
    path: string;
    show(banner: NotificationBanner): void;
  }): Promise<DesktopNotifications> {
    return new DesktopNotifications(
      options,
      (await readLocalSettings(options.path, settingsSchema)) ?? { enabled: false, seen: [] },
    );
  }
  get enabled(): boolean {
    return this.#settings.enabled;
  }
  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => undefined);
    return result;
  }
  setEnabled(enabled: boolean): Promise<void> {
    return this.#serial(async () => {
      const next = { ...this.#settings, enabled };
      await writeLocalSettings(this.options.path, next);
      this.#settings = next;
      if (!enabled) this.#pending.clear();
    });
  }
  receive(instanceId: string, raw: LocalNotification): Promise<void> {
    return this.#serial(async () => {
      const event = localNotificationSchema.parse(raw);
      const key = createHash("sha256")
        .update(JSON.stringify([instanceId, event.enrollmentId, event.id, event.kind]))
        .digest("hex");
      if (this.#settings.seen.includes(key)) return;
      const next = { ...this.#settings, seen: [...this.#settings.seen, key].slice(-2000) };
      await writeLocalSettings(this.options.path, next);
      this.#settings = next;
      if (!next.enabled) return;
      const previous = this.#pending.get(instanceId);
      if (this.#pending.size >= 32 && !previous) return;
      this.#pending.set(instanceId, {
        instanceId,
        count: (previous?.count ?? 0) + 1,
        activity:
          event.kind === "result" && (!previous || previous.activity === "results")
            ? "results"
            : "incoming",
        page:
          event.kind === "permission" && (!previous || previous.page === "permissions")
            ? "permissions"
            : "attention",
      });
    });
  }
  flush(): Promise<void> {
    return this.#serial(async () => {
      const banners = [...this.#pending.values()];
      this.#pending.clear();
      if (!this.enabled) return;
      for (const banner of banners) {
        try {
          this.options.show(banner);
        } catch {
          /* Display is best effort and cannot replay business work. */
        }
      }
    });
  }
}
