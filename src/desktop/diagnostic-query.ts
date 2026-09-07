import { z } from "zod";

export const diagnosticQuerySchema = z.strictObject({
  search: z.string().max(128).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  cursor: z.string().max(8192).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type DiagnosticQuery = z.infer<typeof diagnosticQuerySchema>;
export interface DiagnosticRecord {
  readonly id: string;
  readonly timestamp: string;
  readonly event: string;
  readonly run_id?: string;
  readonly data?: unknown;
}
export interface DiagnosticPage {
  readonly records: DiagnosticRecord[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
  readonly warnings: string[];
}
