import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

export interface Notification {
  notification_id: string;
  delivery_id: string;
  binding_id: string;
  issued_at: string;
  expires_at: string;
}

export interface PollResponse {
  protocol_version: 1;
  cursor: string;
  server_time: string;
  notifications: Notification[];
}

export interface PersistenceAcknowledgement {
  protocol_version: 1;
  notification_id: string;
  delivery_id: string;
  status: "persisted";
  persisted_at: string;
}

export type WakeReportStatus = "accepted" | "retrying" | "failed" | "expired" | "uncertain";

export interface WakeReport {
  protocol_version: 1;
  report_id: string;
  sequence: number;
  notification_id: string;
  delivery_id: string;
  status: WakeReportStatus;
  reason?: string;
  observed_at: string;
  next_attempt_at?: string;
}

export interface WakeRequest {
  protocol_version: 1;
  delivery_id: string;
  sent_at: string;
}

export type WakeResponse =
  | {
      protocol_version: 1;
      status: "accepted";
      session_id?: string | undefined;
    }
  | {
      protocol_version: 1;
      status: "duplicate";
      session_id?: string | undefined;
    }
  | {
      protocol_version: 1;
      status: "retryable_error";
      code: string;
      retry_after_ms?: number | undefined;
    }
  | { protocol_version: 1; status: "permanent_error"; code: string };

const idSchema = z.string().regex(/^[A-Za-z0-9._~-]{1,128}$/);
const utcTimestampSchema = z.iso
  .datetime({ local: false, offset: false })
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);

const notificationSchema = z
  .strictObject({
    notification_id: idSchema,
    delivery_id: idSchema,
    binding_id: idSchema,
    issued_at: utcTimestampSchema,
    expires_at: utcTimestampSchema,
  })
  .refine(
    (notification) => Date.parse(notification.expires_at) > Date.parse(notification.issued_at),
    {
      message: "expires_at must be after issued_at",
      path: ["expires_at"],
    },
  );

const pollResponseSchema = z.strictObject({
  protocol_version: z.literal(PROTOCOL_VERSION),
  cursor: idSchema,
  server_time: utcTimestampSchema,
  notifications: z.array(notificationSchema),
});

const wakeResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    protocol_version: z.literal(PROTOCOL_VERSION),
    status: z.literal("accepted"),
    session_id: idSchema.optional(),
  }),
  z.strictObject({
    protocol_version: z.literal(PROTOCOL_VERSION),
    status: z.literal("duplicate"),
    session_id: idSchema.optional(),
  }),
  z.strictObject({
    protocol_version: z.literal(PROTOCOL_VERSION),
    status: z.literal("retryable_error"),
    code: idSchema,
    retry_after_ms: z.number().int().positive().optional(),
  }),
  z.strictObject({
    protocol_version: z.literal(PROTOCOL_VERSION),
    status: z.literal("permanent_error"),
    code: idSchema,
  }),
]);

function notificationsEqual(left: Notification, right: Notification): boolean {
  return (
    left.notification_id === right.notification_id &&
    left.delivery_id === right.delivery_id &&
    left.binding_id === right.binding_id &&
    left.issued_at === right.issued_at &&
    left.expires_at === right.expires_at
  );
}

export function parsePollResponse(input: unknown): PollResponse {
  const response = pollResponseSchema.parse(input);
  const byNotificationId = new Map<string, Notification>();
  const byDeliveryId = new Map<string, Notification>();
  const notifications: Notification[] = [];

  for (const notification of response.notifications) {
    const existing =
      byNotificationId.get(notification.notification_id) ??
      byDeliveryId.get(notification.delivery_id);

    if (existing) {
      if (notificationsEqual(existing, notification)) {
        continue;
      }
      throw new Error("Conflicting notification or delivery IDs in poll response");
    }

    byNotificationId.set(notification.notification_id, notification);
    byDeliveryId.set(notification.delivery_id, notification);
    notifications.push(notification);
  }

  return { ...response, notifications };
}

export function parseWakeResponse(input: unknown): WakeResponse {
  return wakeResponseSchema.parse(input);
}
