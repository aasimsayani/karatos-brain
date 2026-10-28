import { readFile } from "node:fs/promises";
import { z } from "zod";

/**
 * A mapping profile says how a business's forms are built: which question
 * holds the requested date, the metal, the budget and so on, which kind of
 * request each form is, and the business's own words for metals, stones and
 * pieces. Only the fields a profile maps are ever kept, and a typed answer
 * is kept only when it matches one of the profile's values, so nothing a
 * customer wrote in their own words is stored. The generic profile reads
 * the question names in docs/integrations.md. A profile for one client's
 * forms belongs in that client's private instance repo, never here.
 */

export const SUBMISSION_KINDS = ["appointment_request", "repair_intake", "custom_order_request", "other"] as const;
export type SubmissionKind = (typeof SUBMISSION_KINDS)[number];

export const CONTACT_CHANNELS = ["email", "phone", "text", "in_person", "video"] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

/** A question, by its ref, id or title, or several names for it. Matched without regard to case, spacing or punctuation. */
const Names = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);
const optional = Names.optional();
const Pattern = z.string().min(1);
/** A value a business's forms use, and the patterns that mean it. Patterns are regular expressions, matched case-insensitively. */
const Vocabulary = z.array(z.object({ match: Pattern, value: z.string().regex(/^[a-z0-9_]{1,40}$/) })).default([]);

export const FormProfileSchema = z.object({
  /** Short lowercase name for messages and docs. */
  id: z.string().regex(/^[a-z0-9_]{2,40}$/),
  name: z.string().min(1),
  /** The kind of every submission to a form, by form id, for forms that only take one kind. */
  forms: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), z.enum(SUBMISSION_KINDS)).default({}),
  /** Tested in order against the kind question's answer, then the form's title. */
  kinds: z.array(z.object({ match: Pattern, kind: z.enum(SUBMISSION_KINDS) })).default([]),
  fields: z
    .object({
      /** A question that says what the request is, such as "What can we help with?". */
      kind: optional,
      requestedDate: optional,
      requestedTime: optional,
      itemType: optional,
      metal: optional,
      stone: optional,
      /** A number answer is kept as a whole amount; a choice as its range label. */
      budget: optional,
      contactChannel: optional,
      storeLocation: optional,
      /** Read only to make the customer reference; the address itself is never kept. Email questions are used when absent. */
      email: optional,
      /** Read only to make the customer reference; the number itself is never kept. Phone questions are used when absent. */
      phone: optional,
    })
    .strict(),
  /** The business's values for each field. A typed answer is kept only when it matches one; a choice the form offers is kept as its label. */
  values: z
    .object({
      itemType: Vocabulary,
      metal: Vocabulary,
      stone: Vocabulary,
      budget: Vocabulary,
      storeLocation: Vocabulary,
      requestedTime: Vocabulary,
    })
    .strict()
    .default({ itemType: [], metal: [], stone: [], budget: [], storeLocation: [], requestedTime: [] }),
});

export type FormProfile = z.output<typeof FormProfileSchema>;
export type FormProfileInput = z.input<typeof FormProfileSchema>;
export type FormField = keyof FormProfile["fields"];

export class FormProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormProfileError";
  }
}

export function parseFormProfile(input: unknown): FormProfile {
  const result = FormProfileSchema.safeParse(input);
  if (!result.success) {
    const where = result.error.issues.map((i) => `${i.path.join(".") || "profile"}: ${i.message}`).join("; ");
    throw new FormProfileError(`form mapping profile is not valid: ${where}`);
  }
  const patterns: [string, string][] = result.data.kinds.map((rule, i) => [`kinds.${i}.match`, rule.match]);
  for (const [field, rules] of Object.entries(result.data.values)) rules.forEach((rule, i) => patterns.push([`values.${field}.${i}.match`, rule.match]));
  for (const [where, pattern] of patterns) {
    try {
      new RegExp(pattern, "i");
    } catch {
      throw new FormProfileError(`form mapping profile: ${where} is not a valid pattern`);
    }
  }
  return result.data;
}

/** Reads the question names and values listed under "Custom forms" in docs/integrations.md. */
export const GENERIC_FORM_PROFILE: FormProfile = parseFormProfile({
  id: "generic",
  name: "Generic forms",
  kinds: [
    { match: String.raw`\b(repair|fix|resiz|sizing|clean|polish|re-?tip|prong|solder|battery|restor|broken|service)`, kind: "repair_intake" },
    { match: String.raw`\b(custom|design|bespoke|engagement ring|redesign|remount|commission|quote)`, kind: "custom_order_request" },
    { match: String.raw`\b(appointment|book|consult|visit|schedul|reserv|meet)`, kind: "appointment_request" },
  ],
  fields: {
    kind: ["request type", "type of request", "reason for visit", "how can we help", "what can we help with", "service", "kind"],
    requestedDate: ["preferred date", "appointment date", "requested date", "date", "requestedDate"],
    requestedTime: ["preferred time", "appointment time", "requested time", "time", "requestedTime"],
    itemType: ["item type", "type of item", "type of jewelry", "jewelry type", "piece", "item", "itemType"],
    metal: ["metal", "metal type", "preferred metal"],
    stone: ["stone", "gemstone", "center stone", "stone type"],
    budget: ["budget", "budget range", "price range"],
    contactChannel: ["preferred contact method", "how should we contact you", "contact preference", "contact method", "contactChannel"],
    storeLocation: ["store", "location", "store location", "preferred store", "storeLocation"],
    email: ["email", "email address"],
    phone: ["phone", "phone number", "mobile", "mobile number"],
  },
  values: {
    itemType: [
      { match: String.raw`\bengagement`, value: "engagement_ring" },
      { match: String.raw`\bwedding (band|ring)`, value: "wedding_band" },
      { match: String.raw`\bring`, value: "ring" },
      { match: String.raw`\b(necklace|chain)`, value: "necklace" },
      { match: String.raw`\bpendant`, value: "pendant" },
      { match: String.raw`\bbracelet|\bbangle`, value: "bracelet" },
      { match: String.raw`\bearring|\bstud`, value: "earrings" },
      { match: String.raw`\bwatch`, value: "watch" },
      { match: String.raw`\bbrooch|\bpin\b`, value: "brooch" },
    ],
    metal: [
      { match: String.raw`\bwhite gold`, value: "white_gold" },
      { match: String.raw`\brose gold`, value: "rose_gold" },
      { match: String.raw`\byellow gold|^\s*gold\s*$`, value: "yellow_gold" },
      { match: String.raw`\bplatinum`, value: "platinum" },
      { match: String.raw`\bpalladium`, value: "palladium" },
      { match: String.raw`\b(sterling|silver)`, value: "silver" },
      { match: String.raw`\btitanium`, value: "titanium" },
      { match: String.raw`\b(not sure|unsure|don'?t know)`, value: "undecided" },
    ],
    stone: [
      { match: String.raw`\blab[- ]?(grown|created)`, value: "lab_diamond" },
      { match: String.raw`\bdiamond`, value: "diamond" },
      { match: String.raw`\bmoissanite`, value: "moissanite" },
      { match: String.raw`\bsapphire`, value: "sapphire" },
      { match: String.raw`\bruby`, value: "ruby" },
      { match: String.raw`\bemerald`, value: "emerald" },
      { match: String.raw`\bpearl`, value: "pearl" },
      { match: String.raw`\b(none|no stone)`, value: "none" },
    ],
  },
});

/** A setting of generic, or empty, is the generic profile; anything else is the path to a profile JSON. */
export async function resolveFormProfile(setting: string | undefined, read: (path: string) => Promise<string> = (p) => readFile(p, "utf8")): Promise<FormProfile> {
  const value = setting?.trim() ?? "";
  if (value === "" || value === "generic") return GENERIC_FORM_PROFILE;
  let json: unknown;
  try {
    json = JSON.parse(await read(value));
  } catch (error) {
    throw new FormProfileError(`FORMS_MAPPING_PROFILE: could not read a JSON profile (${error instanceof Error ? error.name : "error"})`);
  }
  return parseFormProfile(json);
}
