import { readFile } from "node:fs/promises";
import { z } from "zod";

/**
 * A parsing profile says how one refiner writes its settlement statements:
 * which columns hold the lot, metal, weights, assay and money, how dates are
 * written, and, for PDF statements, what a settlement line looks like.
 * Weights can be in grams, pennyweight or troy ounces; each has its own
 * columns, so a unit is never guessed. The generic profile reads the common
 * column names. A profile for one client's refiner belongs in that client's
 * private instance repo, never here.
 */

const Column = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);
const optional = Column.optional();
const Pattern = z.string().min(1);

/** The weight units statements use, by the suffix their columns and PDF groups carry. */
export const WEIGHT_UNITS = ["Grams", "Dwt", "Ozt"] as const;
export type WeightUnit = (typeof WEIGHT_UNITS)[number];

/** The fields a settlement line can carry. Weights come in one column per unit. */
export const LINE_FIELDS = [
  "date",
  "lot",
  "metal",
  "description",
  "grossGrams",
  "grossDwt",
  "grossOzt",
  "meltGrams",
  "meltDwt",
  "meltOzt",
  "fineness",
  "fineGrams",
  "fineDwt",
  "fineOzt",
  "price",
  "credit",
  "fee",
  "net",
] as const;
export type LineField = (typeof LINE_FIELDS)[number];

export const RefinerPdfLayoutSchema = z.object({
  /**
   * A settlement line, with named groups for the fields it shows: at least
   * `date`, `lot`, `metal` and either a fine weight (such as `fineDwt`) or a
   * weight and `fineness`. Columns are separated by two or more spaces in the
   * text read from the PDF. A list of patterns is tried in order.
   */
  line: z.union([Pattern, z.array(Pattern).min(1)]),
  /** Lines that look like settlement lines but aren't, such as totals. */
  ignore: z.array(Pattern).default([]),
});

export type RefinerPdfLayout = z.output<typeof RefinerPdfLayoutSchema>;

export const RefinerProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]{2,40}$/),
  name: z.string().min(1),
  delimiter: z.string().length(1).default(","),
  dateOrder: z.enum(["ymd", "mdy", "dmy"]).default("mdy"),
  columns: z.object(Object.fromEntries(LINE_FIELDS.map((f) => [f, f === "date" || f === "lot" || f === "metal" ? Column : optional])) as Record<LineField, typeof optional>),
  /** How this refiner's PDF statements are laid out. PDFs are read only when this is set. */
  pdf: RefinerPdfLayoutSchema.optional(),
});

export type RefinerProfile = z.output<typeof RefinerProfileSchema>;
export type RefinerProfileInput = z.input<typeof RefinerProfileSchema>;

export class RefinerProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefinerProfileError";
  }
}

const groupsOf = (pattern: string) => new Set([...pattern.matchAll(/\(\?<([A-Za-z]+)>/g)].map((m) => m[1]!));

/** Says which required fields a set of columns or groups can't supply. */
function missingFields(has: (field: LineField) => boolean): string[] {
  const missing: string[] = (["date", "lot", "metal"] as const).filter((f) => !has(f));
  const fine = WEIGHT_UNITS.some((u) => has(`fine${u}`));
  const assayed = has("fineness") && WEIGHT_UNITS.some((u) => has(`gross${u}`) || has(`melt${u}`));
  if (!fine && !assayed) missing.push("a fine weight (or a weight and fineness)");
  return missing;
}

export function parseRefinerProfile(input: unknown): RefinerProfile {
  const result = RefinerProfileSchema.safeParse(input);
  if (!result.success) {
    const where = result.error.issues.map((i) => `${i.path.join(".") || "profile"}: ${i.message}`).join("; ");
    throw new RefinerProfileError(`refiner statement profile is not valid: ${where}`);
  }
  const profile = result.data;
  const missing = missingFields((f) => profile.columns[f] !== undefined);
  if (missing.length) throw new RefinerProfileError(`refiner statement profile: columns need ${missing.join(", ")}`);
  if (profile.pdf) {
    const lines = typeof profile.pdf.line === "string" ? [profile.pdf.line] : profile.pdf.line;
    const patterns: [string, string][] = [
      ...lines.map((p, i): [string, string] => [lines.length === 1 ? "pdf.line" : `pdf.line.${i}`, p]),
      ...profile.pdf.ignore.map((p, i): [string, string] => [`pdf.ignore.${i}`, p]),
    ];
    for (const [where, pattern] of patterns) {
      try {
        new RegExp(pattern, "i");
      } catch {
        throw new RefinerProfileError(`refiner statement profile: ${where} is not a valid pattern`);
      }
    }
    lines.forEach((pattern, i) => {
      const groups = groupsOf(pattern);
      const where = lines.length === 1 ? "pdf.line" : `pdf.line.${i}`;
      const unknown = [...groups].filter((g) => !(LINE_FIELDS as readonly string[]).includes(g));
      if (unknown.length) throw new RefinerProfileError(`refiner statement profile: ${where} has groups no field is named for: ${unknown.join(", ")}`);
      const lacking = missingFields((f) => groups.has(f));
      if (lacking.length) throw new RefinerProfileError(`refiner statement profile: ${where} needs named groups for ${lacking.join(", ")}`);
    });
  }
  return profile;
}

/** Reads the column names listed in docs/integrations/refiner_statements.md. */
export const GENERIC_REFINER_PROFILE: RefinerProfile = parseRefinerProfile({
  id: "generic",
  name: "Generic CSV",
  columns: {
    date: ["Settlement Date", "Date", "Settled", "Statement Date"],
    lot: ["Lot", "Lot Number", "Lot #", "Lot No", "Reference", "Ref"],
    metal: ["Metal", "Metal Type"],
    description: ["Description", "Material", "Item"],
    grossGrams: ["Gross Grams", "Gross Weight (g)", "Received Grams"],
    grossDwt: ["Gross DWT", "Gross Weight (dwt)", "Received DWT"],
    grossOzt: ["Gross Oz", "Gross Troy Oz", "Gross Weight (ozt)"],
    meltGrams: ["Melt Grams", "Melt Weight (g)", "Bar Grams"],
    meltDwt: ["Melt DWT", "Melt Weight (dwt)", "Bar DWT"],
    meltOzt: ["Melt Oz", "Melt Troy Oz", "Melt Weight (ozt)"],
    fineness: ["Assay", "Fineness", "Purity", "Assay %"],
    fineGrams: ["Fine Grams", "Fine Weight (g)", "Pure Grams"],
    fineDwt: ["Fine DWT", "Fine Weight (dwt)", "Pure DWT"],
    fineOzt: ["Fine Oz", "Fine Troy Oz", "Fine Ounces", "Fine Weight (ozt)", "Pure Oz"],
    price: ["Price", "Price per Oz", "Metal Price", "Spot"],
    credit: ["Credit", "Metal Value", "Value", "Gross Value", "Amount"],
    fee: ["Fee", "Fees", "Refining Fee", "Charges", "Treatment Charge"],
    net: ["Net", "Net Amount", "Net Value", "Net Credit"],
  },
});

/** Built-in profiles by the name REFINER_STATEMENTS_PROFILES uses. */
export const REFINER_PROFILES: Readonly<Record<string, RefinerProfile>> = Object.freeze({ generic: GENERIC_REFINER_PROFILE });

/**
 * The profiles the REFINER_STATEMENTS_PROFILES setting names: "generic", or
 * the path to a JSON file in the client's private instance repo mapping each
 * refiner folder to a profile or a built-in profile's name (with "*" for the
 * rest). Returns a lookup by folder name.
 */
export async function resolveRefinerProfiles(
  setting: string | undefined,
  read: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<(refiner: string) => RefinerProfile> {
  const value = setting?.trim() ?? "";
  const builtIn = (name: string) => (Object.hasOwn(REFINER_PROFILES, name) ? REFINER_PROFILES[name] : undefined);
  if (value === "") return () => GENERIC_REFINER_PROFILE;
  const named = builtIn(value);
  if (named) return () => named;
  let json: unknown;
  try {
    json = JSON.parse(await read(value));
  } catch (error) {
    throw new RefinerProfileError(`REFINER_STATEMENTS_PROFILES: could not read a JSON file (${error instanceof Error ? error.name : "error"})`);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new RefinerProfileError("REFINER_STATEMENTS_PROFILES: the file must map refiner folders to profiles");
  }
  const profiles = new Map(
    Object.entries(json).map(([folder, profile]) => {
      if (typeof profile !== "string") return [folder, parseRefinerProfile(profile)];
      const found = builtIn(profile);
      if (!found) throw new RefinerProfileError(`REFINER_STATEMENTS_PROFILES: ${JSON.stringify(folder)} names no built-in profile`);
      return [folder, found];
    }),
  );
  return (refiner) => profiles.get(refiner) ?? profiles.get("*") ?? GENERIC_REFINER_PROFILE;
}
