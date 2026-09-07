import { z } from "zod";
import { connectionOperation, connectionProvider } from "./agent-connections.js";
import { appearanceSchema } from "./appearance.js";
import { diagnosticQuerySchema } from "./diagnostic-query.js";
import { ownerCommands } from "./owner-protocol.js";
import { registrationInput } from "./registration.js";

export const DESKTOP_PROTOCOL = 1;
export const instanceId = z.uuid().toLowerCase();
const label = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) =>
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    }),
  );
export const desktopInstanceSchema = z.strictObject({
  id: instanceId,
  name: label,
  port: z.number().int().min(1024).max(65535),
  stateDirectory: z.string().min(1).max(4096),
  workingDirectory: z.string().min(1).max(4096),
  enabled: z.boolean(),
  createdAt: z.iso.datetime(),
  source: z.literal("cli").optional(),
});
export type DesktopInstance = z.infer<typeof desktopInstanceSchema>;

const selected = { instanceId };
const commandSchema = z.discriminatedUnion("type", [
  ...ownerCommands,
  z.strictObject({ type: z.literal("snapshot") }),
  z.strictObject({ type: z.literal("attach_cli") }),
  z.strictObject({ type: z.literal("set_appearance"), appearance: appearanceSchema }),
  z.strictObject({ type: z.literal("set_launch_at_login"), enabled: z.boolean() }),
  z.strictObject({ type: z.literal("set_notifications"), enabled: z.boolean() }),
  z.strictObject({ type: z.literal("enrollment_status"), ...selected }),
  z.strictObject({
    type: z.literal("enrollment_register"),
    ...selected,
    ...registrationInput.shape,
  }),
  z.strictObject({
    type: z.literal("enrollment_verify"),
    ...selected,
    code: z.string().regex(/^\d{6}$/u),
  }),
  z.strictObject({ type: z.literal("enrollment_resend"), ...selected }),
  z.strictObject({ type: z.literal("permissions"), ...selected }),
  z.strictObject({
    type: z.literal("activity"),
    ...selected,
    kind: z.enum(["incoming", "results", "outgoing", "questions"]),
    after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  }),
  z.strictObject({ type: z.literal("start"), ...selected }),
  z.strictObject({ type: z.literal("stop"), ...selected }),
  z.strictObject({
    type: z.literal("clean"),
    ...selected,
    confirmation: z.literal("clear-local-instance"),
    previewId: instanceId.optional(),
  }),
  z.strictObject({ type: z.literal("clean_preview"), ...selected }),
  z.strictObject({ type: z.literal("clean_cancel"), ...selected, previewId: instanceId }),
  z.strictObject({
    type: z.literal("create"),
    name: label,
    port: z.number().int().min(1024).max(65535),
    requestId: instanceId,
    chooseLocation: z.boolean().optional(),
  }),
  z.strictObject({ type: z.literal("sessions"), ...selected }),
  z.strictObject({ type: z.literal("overview"), ...selected }),
  z.strictObject({
    type: z.literal("history"),
    ...selected,
    sessionId: z.string().min(1).max(512),
    after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  }),
  z.strictObject({
    type: z.literal("history_delete"),
    ...selected,
    sessionId: z.string().min(1).max(512),
  }),
  z.strictObject({ type: z.literal("logs"), ...selected, query: diagnosticQuerySchema.optional() }),
  z.strictObject({ type: z.literal("reveal_logs"), ...selected }),
  z.strictObject({ type: z.literal("clear_logs"), ...selected }),
  z.strictObject({
    type: z.literal("export_prepare"),
    ...selected,
    includeBodies: z.boolean(),
    query: diagnosticQuerySchema.optional(),
  }),
  z.strictObject({ type: z.literal("export_save"), ...selected, previewId: instanceId }),
  z.strictObject({ type: z.literal("setup"), ...selected }),
  z.strictObject({
    type: z.literal("agent_connection"),
    ...selected,
    provider: connectionProvider,
    operation: z.union([connectionOperation, z.literal("check")]),
  }),
]);
export type DesktopCommand = z.infer<typeof commandSchema>;
export const workerCommandSchema = z.discriminatedUnion("type", [
  ...commandSchema.options,
  z.strictObject({ type: z.literal("external_process"), ...selected }),
  z.strictObject({ type: z.literal("external_stop"), ...selected, processInstanceId: instanceId }),
]);
export type WorkerCommand = z.infer<typeof workerCommandSchema>;
export function parseDesktopCommand(value: unknown): DesktopCommand {
  return commandSchema.parse(value);
}

export interface GatewaySnapshot {
  readonly id: string;
  readonly state: "stopped" | "starting" | "running" | "stopping" | "error";
  readonly endpoint?: string;
  readonly error?: string;
  readonly startedAt?: string;
  readonly stopReason?: "handoff";
}

export const workerRequestSchema = z.strictObject({
  protocol: z.literal(DESKTOP_PROTOCOL),
  requestId: instanceId,
  command: workerCommandSchema,
});

export const workerInitSchema = z.strictObject({
  protocol: z.literal(DESKTOP_PROTOCOL),
  type: z.literal("initialize"),
  diagnostics: z.enum(["development", "production"]).default("production"),
  instance: desktopInstanceSchema,
});
