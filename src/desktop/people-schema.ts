import { z } from "zod";

export const contactEmail = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(320)
  .regex(/^[^@\s<>:;,\p{Cc}\p{Cf}]+@[^@\s<>:;,\p{Cc}\p{Cf}]+\.[^@\s<>:;,\p{Cc}\p{Cf}]+$/u);
export const contactSchema = z
  .strictObject({
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[^\p{Cc}\p{Cf}]+$/u),
    email: contactEmail,
  })
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 900);
export const contactsSchema = z.array(contactSchema).max(500);
export type Contact = z.infer<typeof contactSchema>;
