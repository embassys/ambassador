import { z } from "zod";
export const ownerEmail = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(320)
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/u);
