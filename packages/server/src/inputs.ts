import { z } from "zod";
import { isDay } from "@karatos/retail";

/** The largest money tolerance a caller may set: one dollar. */
export const VERIFY_MAX_TOLERANCE_CENTS = 100;

/** The body of POST /v1/verify, and the input of a verify task. */
export const VerifyBody = z
  .object({
    system: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "system must be an integration id, such as shopify").optional(),
    from: z.string().refine(isDay, "from must be a day, such as 2026-11-01"),
    to: z.string().refine(isDay, "to must be a day, such as 2026-11-15"),
    /** The largest money difference that still matches, in whole cents. */
    toleranceCents: z.number().int().min(0).max(VERIFY_MAX_TOLERANCE_CENTS).optional(),
  })
  .strict();

/** Signal kinds are lowercase dotted names, such as bank.balance or receivable.invoice. */
export const SIGNAL_KIND = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$/;

