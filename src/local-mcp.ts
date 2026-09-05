import { randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { toWebRequest } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  isLegacyRequest,
  type McpHttpHandler,
  ProtocolError,
  Server,
  type Tool,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { DELIVERY_WORKFLOW_INSTRUCTIONS } from "./delivery-prompt.js";
import {
  LOCAL_CONTROL_PATH,
  type LocalSessionControl,
  LocalSessionControlError,
} from "./local-control.js";
import { serializeLocalToolResult } from "./local-tool-result.js";
import type { CentralToolDefinition } from "./mcp-contract.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_CONTROL_REQUEST_BYTES = 4 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_HEADERS_BYTES = 16 * 1024;
const MAX_SESSIONS = 32;
const MAX_CONCURRENT_TOOL_CALLS = 8;
const MAX_CONCURRENT_WAITS = 32;
const WORKFLOW_REQUEST_TIMEOUT_MS = 640_000;
const LOCAL_REQUEST_TIMEOUT_MS = 35_000;
const SESSION_IDLE_MS = 30 * 60 * 1_000;
const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INSTRUCTIONS =
  "Embassys Ambassador connects this local agent to the Embassys agent network. A registered enrollment with an empty permissions list is still registered; no permissions have been granted yet. Do not register again or ask the user to reconfirm registration in that case. Use the verified enrollment email for this identity unless the user supplies a different address. For meetings with the user, include that email as an attendee when asking another agent to create the event; target_email selects the other agent and does not add the requester as an attendee. When not enrolled and the user asks to register or connect and gives an email, call register_agent immediately. After the emailed code arrives, call verify_email. Use message_box for actions, pending work, owner questions and results. request_action waits up to ten minutes; on timeout show its continuation and check again when the user asks. Omit wait_seconds for the default 600-second wait. Use a shorter wait only when the user asks or a known client timeout requires it; pending work alone is not a reason. If an action requires a reason, use the user's stated purpose or a neutral restatement such as Requested by the user to obtain this contact's phone number. A neutral restatement is sufficient unless the action schema requires a more specific purpose; never invent that purpose. The target person's human decides permissions; the caller cannot approve a denial on their behalf. Present the actual result data, then acknowledge its receipt. A successful background turn does not mean the user received the answer." +
  "\n" +
  DELIVERY_WORKFLOW_INSTRUCTIONS;

function toolErrorMessage(code: string): string {
  switch (code) {
    case "unsupported_email_format":
      return "Embassys rejected this email address format. The current service does not accept '+' email aliases; use the mailbox address without its +tag.";
    case "registration_conflict":
      return "This email is already registered with Embassys. Local clean removes enrollment but does not unregister centrally. Preserve any existing identity backup; central recovery is not available yet.";
    case "central_rate_limited":
      return "Embassys rate-limited this request. Wait before trying again.";
    case "invalid_arguments":
      return "Ambassador rejected the tool arguments. Check the tool schema and try again.";
    case "action_type_unknown":
      return "This exact action name is absent from list_action_types. Select a returned name; do not invent a permission mapping or create a new type.";
    case "invalid_action_payload":
      return "The payload does not match this action's catalog input schema. Correct the payload before making a new request.";
    case "action_schema_unsupported":
      return "Ambassador could not validate this catalog schema within its supported bounds. No new permission or action was submitted.";
    case "request_id_conflict":
      return "The same request UUID was used with different input. Check the original request; use a new UUID only for genuinely new work.";
    case "operation_already_pending":
      return "Existing work for this call or target/action pair is still pending or uncertain. Inspect the existing operation through the inbox instead of submitting again.";
    case "operation_not_found":
      return "This request UUID is not saved in the current enrollment. Check the inbox and the originating request ID; do not recreate uncertain work.";
    case "cursor_invalid":
      return "This receipt cursor does not belong to the saved operation. Check using the original request UUID without a cursor to retrieve current events.";
    case "owner_question_pending":
      return "A question is already pending for this call. Inspect its saved owner_question through the inbox instead of emailing another question.";
    case "invalid_owner_answer":
      return "The answer does not match the pending question, call or offered options. Use the inbox's exact answer instructions.";
    case "action_call_not_pending":
      return "This call is not pending in the current enrollment. Check the inbox before submitting a result or asking its owner.";
    case "profile_conflict":
      return "Ambassador already has a different local delivery profile. Stop Ambassador and run the documented clean command before registering another agent.";
    case "not_enrolled":
      return "Ambassador is not enrolled yet. Register and verify an email first.";
    case "credential_expired":
      return "Ambassador's central credential has expired. Saved inbox and session reads remain available. Keep local state; Embassys does not yet offer credential renewal.";
    case "permission_missing":
      return "No permission exists for this exact action and current identity. Request the same action_type you intend to call; a similarly named permission does not authorize it. Check current permissions after re-enrollment.";
    case "permission_pending":
      return "Permission for this exact action is still pending. Its owner's decision arrives through email.";
    case "permission_denied":
      return "The target person's human denied permission for this exact action. The caller cannot approve it on their behalf. Report the denial; do not suggest a local approval or repeat the request automatically.";
    case "permission_expired":
      return "Permission for this exact action has expired. A new request needs the owner's approval.";
    case "permission_spent":
      return "The single-use permission for this exact action has already been spent. A new action needs a new permission.";
    case "central_request_rejected":
      return "Embassys rejected the request. Check the saved outbound status before retrying; an uncertain submission must not be repeated.";
    case "already_enrolled":
      return "Ambassador is already enrolled.";
    case "verification_failed":
      return "Embassys rejected the verification code or email.";
    default:
      return `Ambassador could not complete the tool call (${code}). Check the diagnostic log directory printed at startup for the error source and redacted details.`;
  }
}

export interface LocalMcpRouter {
  enrollmentContext?(): Record<string, string | boolean>;
  listTools(): Promise<CentralToolDefinition[]>;
  callTool(
    name: string,
    arguments_: Record<string, unknown>,
    signal: AbortSignal,
    clientInfo: LocalMcpClientInfo | undefined,
  ): Promise<Record<string, unknown>>;
}

export interface LocalMcpClientInfo {
  readonly name: string;
  readonly version: string;
}

export class LocalMcpToolError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterMs?: number | null,
    readonly source?: string,
  ) {
    super(toolErrorMessage(code));
    this.name = "LocalMcpToolError";
  }

  get data(): Record<string, unknown> {
    return {
      code: this.code,
      ...(this.retryAfterMs === undefined ? {} : { retry_after_ms: this.retryAfterMs }),
      ...(this.source === undefined ? {} : { source: this.source }),
    };
  }
}

export interface LocalMcpServerOptions {
  port?: number;
  requestTimeoutMs?: number;
  keepAliveMs?: number;
  nowMs?: () => number;
  control?: {
    readonly secret: string;
    readonly sessions: LocalSessionControl;
    readonly stop?: () => void;
  };
}

export class LocalMcpServerError extends Error {
  constructor(
    readonly code: "address_in_use" | "listen_failed",
    readonly port: number,
  ) {
    super("Local MCP server failed");
    this.name = "LocalMcpServerError";
  }
}

interface McpSession {
  id?: string;
  sdk: Server;
  transport: WebStandardStreamableHTTPServerTransport;
  closing: boolean;
  lastActivityMs: number;
  activeRequests: number;
  activeTools: number;
}

class RequestBodyTooLarge extends Error {}
class ResponseBodyTooLarge extends Error {}

function safeHttpError(response: ServerResponse, status: number): void {
  if (!response.headersSent) {
    response.writeHead(status, {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    });
  }
  response.end("Request rejected\n");
}

function readJsonBody(
  request: IncomingMessage,
  maximumBytes = MAX_REQUEST_BYTES,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > maximumBytes) {
        settled = true;
        request.pause();
        reject(new RequestBodyTooLarge());
        return;
      }
      chunks.push(bytes);
    });
    request.once("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        reject(new Error("Invalid request body"));
      }
    });
    request.once("aborted", () => {
      if (settled) return;
      settled = true;
      reject(new Error("Request aborted"));
    });
    request.once("error", () => {
      if (settled) return;
      settled = true;
      reject(new Error("Request failed"));
    });
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWorkflowWait(name: unknown, arguments_: unknown): boolean {
  return (
    name === "message_box" &&
    isObject(arguments_) &&
    ["request_action", "request_permission", "check"].includes(String(arguments_.type))
  );
}

function exactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return (
    required.every((key) => key in value) &&
    Object.keys(value).every((key) => required.includes(key))
  );
}

function authorizedControlRequest(request: IncomingMessage, secret: string): boolean {
  const supplied = request.headers.authorization;
  if (typeof supplied !== "string") return false;
  const expected = `Bearer ${secret}`;
  const suppliedBytes = Buffer.from(supplied, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

function writeControlJson(
  response: ServerResponse,
  status: number,
  value: Record<string, unknown>,
): void {
  let responseStatus = status;
  let body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.byteLength > MAX_RESPONSE_BYTES) {
    responseStatus = 500;
    body = Buffer.from('{"error":"operation_failed"}', "utf8");
  }
  response.writeHead(responseStatus, {
    "cache-control": "no-store",
    "content-length": body.byteLength,
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function isInitializeRequest(value: unknown): boolean {
  return isObject(value) && value.method === "initialize";
}

function sessionId(request: IncomingMessage): string | undefined {
  const value = request.headers["mcp-session-id"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function responseHeaders(response: Response): Record<string, string> {
  return Object.fromEntries(response.headers.entries());
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseBodyTooLarge();
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseBodyTooLarge();
      }
      chunks.push(item.value);
    }
  } catch (error) {
    if (error instanceof ResponseBodyTooLarge) throw error;
    throw new Error("MCP response failed");
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function writeWebResponse(
  request: IncomingMessage,
  response: ServerResponse,
  webResponse: Response,
  signal: AbortSignal,
): Promise<void> {
  if (
    request.method !== "GET" &&
    !webResponse.headers.get("content-type")?.startsWith("text/event-stream")
  ) {
    const bytes = await readBoundedResponse(webResponse);
    response.writeHead(webResponse.status, responseHeaders(webResponse));
    response.end(bytes);
    return;
  }

  response.writeHead(webResponse.status, responseHeaders(webResponse));
  response.flushHeaders();
  if (webResponse.body === null) {
    response.end();
    return;
  }

  const reader = webResponse.body.getReader();
  let total = 0;
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  response.once("close", cancel);
  try {
    while (!response.destroyed) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        break;
      }
      if (!response.write(item.value)) await once(response, "drain", { signal });
    }
  } finally {
    response.off("close", cancel);
    if (!response.destroyed) response.end();
  }
}

export class LocalMcpServer {
  readonly #http: HttpServer;
  readonly #requestTimeoutMs: number;
  readonly #port: number;
  readonly #control: LocalMcpServerOptions["control"];
  readonly #instanceId = randomUUID();
  #stopRequested = false;
  readonly #nowMs: () => number;
  #sessionSweep: NodeJS.Timeout | undefined;
  readonly #sessions = new Map<string, McpSession>();
  readonly #sessionRecords = new Set<McpSession>();
  #activeToolCalls = 0;
  #activeWaits = 0;
  readonly #modern: McpHttpHandler;
  readonly #keepAliveMs: number;
  #accepting = false;
  #endpoint: string | undefined;

  constructor(
    private readonly router: LocalMcpRouter,
    options: LocalMcpServerOptions = {},
  ) {
    this.#port = options.port ?? 8787;
    this.#control = options.control;
    this.#nowMs = options.nowMs ?? Date.now;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? LOCAL_REQUEST_TIMEOUT_MS;
    this.#keepAliveMs = options.keepAliveMs ?? 15_000;
    this.#modern = createMcpHandler(() => this.#createSdk(), {
      legacy: "reject",
      responseMode: "sse",
      keepAliveMs: this.#keepAliveMs,
      maxSubscriptions: 0,
    });
    if (!Number.isInteger(this.#port) || this.#port < 0 || this.#port > 65_535) {
      throw new Error("Invalid MCP listener port");
    }
    if (!Number.isFinite(this.#requestTimeoutMs) || this.#requestTimeoutMs <= 0) {
      throw new Error("Invalid MCP request timeout");
    }

    this.#http = createHttpServer(
      { maxHeaderSize: MAX_HEADERS_BYTES, requestTimeout: this.#requestTimeoutMs },
      (request, response) => {
        void this.#handleRequest(request, response);
      },
    );
  }

  get endpoint(): string {
    if (this.#endpoint === undefined) throw new Error("MCP listener is not bound");
    return this.#endpoint;
  }

  async listen(): Promise<void> {
    if (this.#accepting || this.#endpoint !== undefined) {
      throw new Error("MCP listener is already bound");
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void =>
        reject(
          new LocalMcpServerError(
            error.code === "EADDRINUSE" ? "address_in_use" : "listen_failed",
            this.#port,
          ),
        );
      this.#http.once("error", onError);
      this.#http.listen(this.#port, "127.0.0.1", () => {
        this.#http.off("error", onError);
        resolve();
      });
    });
    const address = this.#http.address() as AddressInfo;
    this.#endpoint = `http://127.0.0.1:${address.port}/mcp`;
    this.#accepting = true;
    this.#sessionSweep = setInterval(() => this.#expireSessions(), 60_000);
    this.#sessionSweep.unref();
  }

  async close(): Promise<void> {
    this.#accepting = false;
    clearInterval(this.#sessionSweep);
    const closed = new Promise<void>((resolve) => {
      if (!this.#http.listening) {
        resolve();
        return;
      }
      this.#http.close(() => resolve());
    });
    await Promise.all([...this.#sessionRecords].map((record) => this.#closeSession(record)));
    await this.#modern.close();
    this.#http.closeAllConnections();
    await closed;
  }

  #createSdk(session?: () => McpSession): Server {
    const sdk = new Server(
      { name: "ambassador", title: "Embassys Ambassador", version: "1" },
      {
        capabilities: { tools: {} },
        instructions:
          [
            ...(this.router.enrollmentContext === undefined
              ? []
              : [`Local Embassys enrollment: ${JSON.stringify(this.router.enrollmentContext())}.`]),
            SERVER_INSTRUCTIONS,
          ].join(" ") +
          " Enrollment metadata at initialization is a snapshot; later successful verification and tool responses supersede it.",
        supportedProtocolVersions: ["2026-07-28", "2025-11-25", PROTOCOL_VERSION],
      },
    );
    sdk.onerror = () => undefined;
    sdk.setRequestHandler("tools/list", async () => {
      const tools = await this.router.listTools();
      return { tools: tools as Tool[] };
    });
    sdk.setRequestHandler("tools/call", async (request, context) => {
      const arguments_ = request.params.arguments;
      if (arguments_ !== undefined && !isObject(arguments_)) {
        throw new Error("Invalid tool arguments");
      }

      const waiting = isWorkflowWait(request.params.name, arguments_);
      if (
        waiting
          ? this.#activeWaits >= MAX_CONCURRENT_WAITS
          : this.#activeToolCalls >= MAX_CONCURRENT_TOOL_CALLS
      )
        throw new Error("Tool call capacity reached");
      if (waiting) this.#activeWaits++;
      else this.#activeToolCalls++;
      const record = session?.();
      if (record !== undefined) record.activeTools += 1;
      let stopProgress: (() => void) | undefined;
      try {
        const signal = AbortSignal.any([
          context.mcpReq.signal,
          AbortSignal.timeout(waiting ? WORKFLOW_REQUEST_TIMEOUT_MS : this.#requestTimeoutMs),
        ]);
        const progressToken = request.params._meta?.progressToken;
        if (
          waiting &&
          arguments_?.wait_seconds !== 0 &&
          ((typeof progressToken === "string" && progressToken.length <= 256) ||
            (typeof progressToken === "number" && Number.isSafeInteger(progressToken)))
        ) {
          const started = performance.now();
          let active = true;
          let timer: NodeJS.Timeout | undefined;
          stopProgress = () => {
            active = false;
            clearTimeout(timer);
            signal.removeEventListener("abort", stopProgress as () => void);
          };
          signal.addEventListener("abort", stopProgress, { once: true });
          const notify = async (): Promise<void> => {
            if (!active || signal.aborted) return;
            try {
              await context.mcpReq.notify({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: performance.now() - started,
                  message: "Waiting for an Embassys update.",
                },
              });
              if (active && !signal.aborted)
                timer = setTimeout(() => void notify(), this.#keepAliveMs);
            } catch {
              stopProgress?.();
            }
          };
          timer = setTimeout(() => void notify(), this.#keepAliveMs);
        }
        const version = sdk.getClientVersion();
        const clientInfo =
          version !== undefined &&
          typeof version.name === "string" &&
          typeof version.version === "string"
            ? { name: version.name, version: version.version }
            : undefined;
        const result = await this.router.callTool(
          request.params.name,
          arguments_ ?? {},
          signal,
          clientInfo,
        );
        const serialized = serializeLocalToolResult(result);
        return sdk.projectCallToolResult(
          {
            content: [{ type: "text", text: serialized }],
            structuredContent: result,
          },
          undefined,
        );
      } catch (error) {
        if (error instanceof LocalMcpToolError) {
          throw new ProtocolError(-32_002, error.message, error.data);
        }
        throw new Error("Tool call failed");
      } finally {
        stopProgress?.();
        if (waiting) this.#activeWaits--;
        else this.#activeToolCalls--;
        if (record !== undefined) {
          record.activeTools -= 1;
          record.lastActivityMs = this.#nowMs();
        }
      }
    });
    return sdk;
  }

  async #createSession(): Promise<McpSession> {
    this.#expireSessions();
    if (this.#sessionRecords.size >= MAX_SESSIONS) {
      const idle = [...this.#sessionRecords]
        .filter(
          (record) =>
            record.activeRequests === 0 && record.activeTools === 0 && record.id !== undefined,
        )
        .sort((a, b) => a.lastActivityMs - b.lastActivityMs)[0];
      if (idle !== undefined) void this.#closeSession(idle);
    }
    if (this.#sessionRecords.size >= MAX_SESSIONS) {
      throw new Error("MCP session capacity reached");
    }
    let record: McpSession;
    const sdk = this.#createSdk(() => record);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      keepAliveMs: this.#keepAliveMs,
      onsessioninitialized: (id) => {
        if (this.#sessions.has(id)) throw new Error("Duplicate MCP session");
        record.id = id;
        this.#sessions.set(id, record);
      },
      onsessionclosed: (id) => {
        this.#sessions.delete(id);
        void this.#closeSession(record);
      },
    });
    record = {
      sdk,
      transport,
      closing: false,
      lastActivityMs: this.#nowMs(),
      activeRequests: 0,
      activeTools: 0,
    };
    this.#sessionRecords.add(record);
    try {
      await sdk.connect(transport);
      return record;
    } catch (error) {
      this.#sessionRecords.delete(record);
      await sdk.close().catch(() => undefined);
      throw error;
    }
  }

  async #closeSession(record: McpSession): Promise<void> {
    if (record.closing) return;
    record.closing = true;
    if (record.id !== undefined) this.#sessions.delete(record.id);
    this.#sessionRecords.delete(record);
    await record.sdk.close().catch(() => undefined);
  }

  #expireSessions(): void {
    const cutoff = this.#nowMs() - SESSION_IDLE_MS;
    for (const record of this.#sessionRecords) {
      if (
        record.activeRequests === 0 &&
        record.activeTools === 0 &&
        record.lastActivityMs <= cutoff
      )
        void this.#closeSession(record);
    }
  }

  async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.#accepting) {
      safeHttpError(response, 503);
      return;
    }
    if (request.url === LOCAL_CONTROL_PATH) {
      await this.#handleControlRequest(request, response);
      return;
    }
    if (request.url !== "/mcp") {
      safeHttpError(response, 404);
      return;
    }

    const address = this.#http.address() as AddressInfo;
    if (request.headers.host !== `127.0.0.1:${address.port}`) {
      safeHttpError(response, 421);
      return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== `http://127.0.0.1:${address.port}`) {
      safeHttpError(response, 403);
      return;
    }
    if (request.headers.authorization !== undefined) {
      safeHttpError(response, 400);
      return;
    }

    const controller = new AbortController();
    let timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    const onResponseClose = (): void => {
      if (!response.writableEnded) controller.abort();
    };
    response.once("close", onResponseClose);
    let record: McpSession | undefined;
    let transientSession = false;
    let activeRequest = false;
    try {
      const parsedBody = request.method === "POST" ? await readJsonBody(request) : undefined;
      if (Array.isArray(parsedBody)) {
        safeHttpError(response, 400);
        return;
      }
      if (
        isObject(parsedBody) &&
        parsedBody.method === "tools/call" &&
        isObject(parsedBody.params) &&
        isWorkflowWait(parsedBody.params.name, parsedBody.params.arguments)
      ) {
        clearTimeout(timeout);
        timeout = setTimeout(() => controller.abort(), WORKFLOW_REQUEST_TIMEOUT_MS);
      }
      const webRequest = await toWebRequest(
        request as IncomingMessage & { method: string; url: string },
        parsedBody,
        { signal: controller.signal },
      );
      if (!(await isLegacyRequest(webRequest, parsedBody))) {
        if (
          request.method === "POST" &&
          request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json"
        ) {
          safeHttpError(response, 415);
          return;
        }
        const webResponse = await this.#modern.fetch(webRequest, { parsedBody });
        await writeWebResponse(request, response, webResponse, controller.signal);
        return;
      }
      const id = sessionId(request);
      this.#expireSessions();
      if (id === undefined) {
        if (request.method !== "POST" || !isInitializeRequest(parsedBody)) {
          safeHttpError(response, 400);
          return;
        }
        try {
          record = await this.#createSession();
          transientSession = true;
        } catch {
          safeHttpError(response, 503);
          return;
        }
      } else {
        record = this.#sessions.get(id);
        if (record === undefined) {
          safeHttpError(response, 404);
          return;
        }
      }

      record.activeRequests += 1;
      record.lastActivityMs = this.#nowMs();
      activeRequest = true;
      const webResponse = await record.transport.handleRequest(webRequest, { parsedBody });
      await writeWebResponse(request, response, webResponse, controller.signal);
      if (transientSession && record.id === undefined) await this.#closeSession(record);
    } catch (error) {
      if (transientSession && record !== undefined && record.id === undefined) {
        await this.#closeSession(record);
      }
      if (error instanceof RequestBodyTooLarge) {
        request.resume();
        safeHttpError(response, 413);
        return;
      }
      if (!response.headersSent) safeHttpError(response, 400);
    } finally {
      if (record !== undefined && activeRequest) {
        record.activeRequests -= 1;
        record.lastActivityMs = this.#nowMs();
      }
      clearTimeout(timeout);
      response.off("close", onResponseClose);
    }
  }

  async #handleControlRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const control = this.#control;
    if (control === undefined) {
      safeHttpError(response, 404);
      return;
    }
    const address = this.#http.address() as AddressInfo;
    if (request.headers.host !== `127.0.0.1:${address.port}`) {
      safeHttpError(response, 421);
      return;
    }
    if (request.headers.origin !== undefined) {
      safeHttpError(response, 403);
      return;
    }
    if (!authorizedControlRequest(request, control.secret)) {
      writeControlJson(response, 401, { error: "unauthorized" });
      return;
    }
    if (request.method !== "POST" || request.headers["content-type"] !== "application/json") {
      writeControlJson(response, 400, { error: "operation_failed" });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    const onResponseClose = (): void => {
      if (!response.writableEnded) controller.abort();
    };
    response.once("close", onResponseClose);
    try {
      const body = await readJsonBody(request, MAX_CONTROL_REQUEST_BYTES);
      if (!isObject(body) || typeof body.operation !== "string") {
        writeControlJson(response, 400, { error: "operation_failed" });
        return;
      }
      if (
        body.operation === "process.status" &&
        exactKeys(body, ["operation"]) &&
        control.stop !== undefined
      ) {
        writeControlJson(response, 200, { instance_id: this.#instanceId });
        return;
      }
      if (
        body.operation === "process.stop" &&
        exactKeys(body, ["operation", "instance_id"]) &&
        body.instance_id === this.#instanceId &&
        control.stop !== undefined
      ) {
        response.once("finish", () => {
          if (this.#stopRequested) return;
          this.#stopRequested = true;
          control.stop?.();
        });
        writeControlJson(response, 200, { stopping: true });
        return;
      }
      if (body.operation === "sessions.list" && exactKeys(body, ["operation"])) {
        writeControlJson(response, 200, { sessions: [...(await control.sessions.list())] });
        return;
      }
      if (
        body.operation === "sessions.show" &&
        exactKeys(body, ["operation", "session_id", "verbose"]) &&
        typeof body.session_id === "string" &&
        body.session_id.length >= 1 &&
        body.session_id.length <= 512 &&
        typeof body.verbose === "boolean"
      ) {
        const lines = await control.sessions.show(body.session_id, body.verbose, controller.signal);
        writeControlJson(response, 200, { lines: [...lines] });
        return;
      }
      writeControlJson(response, 400, { error: "operation_failed" });
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) {
        request.resume();
        writeControlJson(response, 413, { error: "operation_failed" });
        return;
      }
      if (error instanceof LocalSessionControlError) {
        const status = error.code === "session_not_found" ? 404 : 422;
        writeControlJson(response, status, { error: error.code });
        return;
      }
      writeControlJson(response, 500, { error: "operation_failed" });
    } finally {
      clearTimeout(timeout);
      response.off("close", onResponseClose);
    }
  }
}
