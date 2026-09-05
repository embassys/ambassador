import { z } from "zod";

// UUID text is case-insensitive. Normalize protocol IDs before indexing,
// fingerprinting or correlating them; never normalize arbitrary payload strings.
export const workflowUuid = z.uuid().toLowerCase();
