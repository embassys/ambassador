import { z } from "zod";
import { diagnosticQuerySchema } from "./diagnostic-query.js";

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
});
export type DesktopInstance = z.infer<typeof desktopInstanceSchema>;

const selected = { instanceId };
const commandSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("snapshot") }),
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
  z.strictObject({
    type: z.literal("export_prepare"),
    ...selected,
    includeBodies: z.boolean(),
    query: diagnosticQuerySchema.optional(),
  }),
  z.strictObject({ type: z.literal("export_save"), ...selected, previewId: instanceId }),
  z.strictObject({ type: z.literal("setup"), ...selected }),
]);
export type DesktopCommand = z.infer<typeof commandSchema>;
export function parseDesktopCommand(value: unknown): DesktopCommand {
  return commandSchema.parse(value);
}

export interface GatewaySnapshot {
  readonly id: string;
  readonly state: "stopped" | "starting" | "running" | "stopping" | "error";
  readonly endpoint?: string;
  readonly error?: string;
  readonly startedAt?: string;
}

export const workerRequestSchema = z.strictObject({
  protocol: z.literal(DESKTOP_PROTOCOL),
  requestId: instanceId,
  command: commandSchema,
});

export const workerInitSchema = z.strictObject({
  protocol: z.literal(DESKTOP_PROTOCOL),
  type: z.literal("initialize"),
  instance: desktopInstanceSchema,
});
