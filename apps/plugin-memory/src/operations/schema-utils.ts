import { z } from "zod";

export function objectOutputSchema<T>(): z.ZodType<T> {
  return z.custom<T>((value) => value !== null && typeof value === "object");
}
