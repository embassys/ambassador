import { z } from "zod";

export const diagnosticQuerySchema = z.strictObject({
  search: z.string().max(128).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  offset: z.number().int().min(0).max(100_000).optional(),
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
  readonly total: number;
  readonly hasMore: boolean;
  readonly nextOffset: number;
  readonly warnings: string[];
}
