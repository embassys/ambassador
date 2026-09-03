export interface AmbassadorWebhookVerificationInput {
  readonly method: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
  readonly secret: string;
  readonly nowSeconds: number;
}

export type AmbassadorWebhookVerification =
  | { readonly ok: true; readonly message: Record<string, unknown> }
  | { readonly ok: false; readonly status: 400 | 401 | 405 | 413 };

export function verifyAmbassadorWebhook(
  input: AmbassadorWebhookVerificationInput,
): AmbassadorWebhookVerification;

export function buildAmbassadorPrompt(message: Record<string, unknown>): string;

export type OpenClawExecutionErrorClassification =
  | "plugin_runtime_scope"
  | "session_admission"
  | "plugin_admission"
  | "model_start"
  | "workspace"
  | "configuration"
  | "unknown";

export function classifyOpenClawExecutionError(
  error: unknown,
): OpenClawExecutionErrorClassification;

export interface OpenClawQueuedWork {
  readonly requestId: string;
  readonly prompt: string;
}

export interface BoundedOpenClawWorkQueue<T> {
  enqueue(value: T): boolean;
  next(): Promise<T | undefined>;
  close(): void;
}

export function createBoundedOpenClawWorkQueue<T>(capacity: number): BoundedOpenClawWorkQueue<T>;
