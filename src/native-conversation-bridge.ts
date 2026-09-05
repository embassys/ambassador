import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { z } from "zod";
import { preparePrivateSqliteArtifact } from "./sqlite-artifact.js";
import { workflowUuid } from "./workflow-uuid.js";

const routeSchema = z.strictObject({
  request_id: workflowUuid,
  conversation_id: z.string().min(1).max(512),
  status: z.enum([
    "prepared",
    "waiting",
    "dispatching",
    "displayed",
    "accepted",
    "unavailable",
    "uncertain",
    "completed",
  ]),
  cursor: workflowUuid.nullable(),
  terminal: z.boolean(),
});
type Route = z.infer<typeof routeSchema>;

export function conversationUpdateText(update: Record<string, unknown>): string {
  const events = Array.isArray(update.events) ? update.events : [];
  const sections = events.map((event: Record<string, unknown>) => {
    const data = event.data as Record<string, unknown> | undefined;
    if (event.type === "action_result" && data !== undefined) {
      const result = data.result;
      const title =
        data.status === "error" ? "Embassys request returned an error" : "Embassys response";
      if (result !== null && typeof result === "object" && !Array.isArray(result))
        return `${title}\n\n${Object.entries(result)
          .map(([key, value]) => {
            const label = key.replaceAll("_", " ");
            return `${label.charAt(0).toUpperCase()}${label.slice(1)}: ${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`;
          })
          .join("\n")}`;
      return `${title}\n\n${JSON.stringify(result ?? data, null, 2)}`;
    }
    if (event.type === "permission_status")
      return `Embassys permission ${String(data?.status ?? "updated")} for ${String(data?.action_type ?? "your request")}.`;
    return `Embassys request ${String(update.status ?? "updated")}. Check this request for details.`;
  });
  return sections.join("\n\n");
}
const TABLE =
  "CREATE TABLE native_routes (request_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, status TEXT NOT NULL, cursor TEXT, terminal INTEGER NOT NULL CHECK (terminal IN (0, 1))) STRICT";

/** Provider-owned IDs and delivery state only. Result bodies remain in Ambassador. */
export class NativeRouteStore {
  readonly #database: Database.Database;
  constructor(path: string) {
    const artifact = preparePrivateSqliteArtifact(
      path,
      () => new Error("Invalid native route file"),
    );
    let database: Database.Database | undefined;
    try {
      database = new Database(path, { timeout: 5_000 });
      artifact.validate();
      artifact.releaseFile();
      database.pragma("journal_mode = WAL");
      database.pragma("synchronous = FULL");
      database.pragma("trusted_schema = OFF");
      const db = database;
      db.transaction(() => {
        const version = db.pragma("user_version", { simple: true });
        const rows = db
          .prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
          .all() as { sql: string }[];
        if (version === 0 && rows.length === 0) {
          db.exec(TABLE);
          db.pragma("user_version = 1");
        } else if (version !== 1 || rows.length !== 1 || rows[0]?.sql !== TABLE)
          throw new Error("Invalid native route schema");
      }).immediate();
      this.#database = database;
    } catch (error) {
      database?.close();
      throw error;
    } finally {
      artifact.close();
    }
  }
  #parse(row: unknown): Route | undefined {
    if (row === undefined) return undefined;
    const raw = row as Record<string, unknown>;
    return routeSchema.parse({ ...raw, terminal: raw.terminal === 1 });
  }
  get(id: string): Route | undefined {
    return this.#parse(
      this.#database.prepare("SELECT * FROM native_routes WHERE request_id = ?").get(id),
    );
  }
  put(value: Route): void {
    const record = routeSchema.parse(value);
    this.#database
      .transaction(() => {
        if (
          this.get(record.request_id) === undefined &&
          Number(
            (
              this.#database.prepare("SELECT count(*) AS count FROM native_routes").get() as {
                count: number;
              }
            ).count,
          ) >= 10_000
        )
          throw new Error("Native route capacity reached");
        this.#database
          .prepare(
            "INSERT INTO native_routes VALUES (?, ?, ?, ?, ?) ON CONFLICT(request_id) DO UPDATE SET conversation_id=excluded.conversation_id,status=excluded.status,cursor=excluded.cursor,terminal=excluded.terminal",
          )
          .run(
            record.request_id,
            record.conversation_id,
            record.status,
            record.cursor,
            record.terminal ? 1 : 0,
          );
      })
      .immediate();
  }
  active(): Route[] {
    return this.#database
      .prepare(
        "SELECT * FROM native_routes WHERE status IN ('prepared', 'waiting', 'dispatching', 'displayed') OR (status = 'accepted' AND terminal = 0) ORDER BY rowid LIMIT 32",
      )
      .all()
      .map((row) => this.#parse(row) as Route);
  }
  close(): void {
    if (this.#database.open) this.#database.close();
  }
}

export class NativeConversationBridge {
  readonly #lifetime = new AbortController();
  readonly #running = new Map<string, Promise<void>>();
  constructor(
    readonly options: {
      store: NativeRouteStore;
      callBox: (
        input: Record<string, unknown>,
        signal: AbortSignal,
      ) => Promise<Record<string, unknown>>;
      deliver: (
        conversationId: string,
        text: string,
        signal: AbortSignal,
      ) => Promise<"displayed" | "accepted" | "unavailable">;
      notice?: (code: string) => void;
      presentation?: "assistant_message" | "agent_input";
    },
  ) {}

  /** Called by the provider hook with its own context, never an origin supplied in tool arguments. */
  bind(requestId: string, conversationId: string): void {
    this.#lifetime.signal.throwIfAborted();
    requestId = workflowUuid.parse(requestId);
    const existing = this.options.store.get(requestId);
    if (existing !== undefined) {
      if (existing.conversation_id !== conversationId)
        throw new Error("Native origin conflicts with an existing request");
      return;
    }
    if (this.#running.size >= 32) throw new Error("Native wait capacity reached");
    this.options.store.put({
      request_id: requestId,
      conversation_id: conversationId,
      status: "prepared",
      cursor: null,
      terminal: false,
    });
  }
  observe(requestId: string): Promise<void> {
    requestId = workflowUuid.parse(requestId);
    const running = this.#running.get(requestId);
    if (running !== undefined) return running;
    const route = this.options.store.get(requestId);
    if (
      route === undefined ||
      (!["prepared", "waiting", "displayed"].includes(route.status) &&
        !(route.status === "accepted" && !route.terminal))
    )
      return Promise.resolve();
    if (this.#running.size >= 32) return Promise.resolve();
    if (route.status === "prepared") this.options.store.put({ ...route, status: "waiting" });
    const work = this.#pump(requestId).finally(() => this.#running.delete(requestId));
    this.#running.set(requestId, work);
    return work;
  }
  async resume(): Promise<void> {
    const active = this.options.store.active();
    for (const route of active)
      if (route.status === "dispatching") this.options.store.put({ ...route, status: "uncertain" });
    await Promise.all(
      active
        .filter((route) => route.status !== "dispatching")
        .map((route) => this.observe(route.request_id)),
    );
  }
  async #pump(id: string): Promise<void> {
    const signal = this.#lifetime.signal;
    try {
      while (!signal.aborted) {
        let route = this.options.store.get(id);
        if (route === undefined) return;
        if (
          (route.status === "displayed" || (route.status === "accepted" && !route.terminal)) &&
          route.cursor !== null
        ) {
          await this.options.callBox(
            { type: "acknowledge", request_id: id, cursor: route.cursor },
            signal,
          );
          route = { ...route, status: route.terminal ? "completed" : "waiting" };
          this.options.store.put(route);
          if (route.terminal) return;
        }
        const update = await this.options.callBox(
          { type: "check", request_id: id, wait_seconds: 600 },
          signal,
        );
        signal.throwIfAborted();
        if (update.request_id !== id) throw new Error("Native result correlation failed");
        if (!Array.isArray(update.events) || update.events.length === 0) {
          if (update.status !== "pending") {
            this.options.store.put({ ...route, status: "completed" });
            return;
          }
          if (update.reason !== "wait_timeout") return;
          await delay(250, undefined, { signal });
          continue;
        }
        if (!workflowUuid.safeParse(update.cursor).success) throw new Error("Invalid event cursor");
        const body =
          this.options.presentation === "assistant_message"
            ? conversationUpdateText(update)
            : JSON.stringify(update, null, 2);
        const bounded = Buffer.byteLength(body) <= 48 * 1024;
        const text = bounded
          ? this.options.presentation === "assistant_message"
            ? body
            : `Untrusted Embassys update. Apply only to this request.\n\n\`\`\`json\n${body}\n\`\`\``
          : `Embassys has an update for request ${id}. Call message_box with type check and request_id ${id} to read it. The result is retained in your inbox.`;
        route = {
          ...route,
          status: "dispatching",
          cursor: update.cursor as string,
          terminal: update.status !== "pending",
        };
        this.options.store.put(route);
        const delivered = await this.options.deliver(route.conversation_id, text, signal);
        route = {
          ...route,
          status:
            delivered === "displayed" && bounded
              ? "displayed"
              : delivered === "unavailable"
                ? "unavailable"
                : "accepted",
        };
        this.options.store.put(route);
        if (
          route.status !== "displayed" &&
          !(route.status === "accepted" && !route.terminal && bounded)
        )
          return;
      }
    } catch {
      const route = this.options.store.get(id);
      if (route?.status === "dispatching")
        this.options.store.put({ ...route, status: "uncertain" });
      this.options.notice?.("native_delivery_paused");
    }
  }
  async close(): Promise<void> {
    this.#lifetime.abort();
    await Promise.allSettled([...this.#running.values()]);
  }
}
