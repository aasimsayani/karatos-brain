import { readFile } from "node:fs/promises";
import { z } from "zod";

/**
 * A mapping profile says how a PIRO account writes its report exports: which
 * files are job reports and which are casting tree reports, which column
 * holds each value, how dates are written, and any status labels the shop
 * added. PIRO lets each account choose report columns, so the generic
 * profile reads the common names in docs/integrations/piro.md and a client's
 * own profile, kept in their private instance repo, covers the rest. Weights
 * come in grams or pennyweight, each with its own columns, so a unit is
 * never guessed.
 */

const Column = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);
const optional = Column.optional();

const JobColumns = z.object({
  jobId: Column,
  status: Column,
  updatedDate: optional,
  stage: optional,
  styleNumber: optional,
  sku: optional,
  orderNumber: optional,
  metal: optional,
  karat: optional,
  quantity: optional,
  dueDate: optional,
  startDate: optional,
  completedDate: optional,
  estimatedGrams: optional,
  estimatedDwt: optional,
  actualGrams: optional,
  actualDwt: optional,
  treeId: optional,
});

const CastingColumns = z.object({
  treeId: Column,
  castDate: Column,
  metal: Column,
  karat: optional,
  status: optional,
  /** Metal issued to the tree. */
  issuedGrams: optional,
  issuedDwt: optional,
  /** Everything that came back: castings plus the button, sprues and scrap. Summed from the two when absent. */
  returnedGrams: optional,
  returnedDwt: optional,
  castingsGrams: optional,
  castingsDwt: optional,
  scrapGrams: optional,
  scrapDwt: optional,
  /** The jobs on the tree, separated by commas, semicolons or spaces. */
  jobs: optional,
});

export const PIRO_FILE_KINDS = ["jobs", "casting"] as const;
export type PiroFileKind = (typeof PIRO_FILE_KINDS)[number];

export const JOB_STATUSES = ["open", "in_progress", "on_hold", "completed", "cancelled", "other"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const PiroProfileSchema = z.object({
  /** Short lowercase name for messages and docs. */
  id: z.string().regex(/^[a-z0-9_]{2,40}$/),
  name: z.string().min(1),
  delimiter: z.string().length(1).default(","),
  dateOrder: z.enum(["ymd", "mdy", "dmy"]).default("mdy"),
  /** The shop's offset from UTC, for times written without one. */
  utcOffset: z.string().regex(/^(Z|[+-]\d{2}:\d{2})$/).default("Z"),
  /** Regular expressions tested against each file name, case-insensitive. The first match decides; unmatched files are skipped. */
  files: z.object({ jobs: z.string().min(1).optional(), casting: z.string().min(1).optional() }),
  columns: z.object({ jobs: JobColumns.optional(), casting: CastingColumns.optional() }),
  /** The shop's own status labels, lowercased, mapped to a status. Checked before the built-in ones. */
  statuses: z.record(z.string(), z.enum(JOB_STATUSES)).default({}),
});

export type PiroProfile = z.output<typeof PiroProfileSchema>;
export type PiroProfileInput = z.input<typeof PiroProfileSchema>;
export type JobColumnMap = z.output<typeof JobColumns>;
export type CastingColumnMap = z.output<typeof CastingColumns>;

export class PiroProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiroProfileError";
  }
}

export function parsePiroProfile(input: unknown): PiroProfile {
  const result = PiroProfileSchema.safeParse(input);
  if (!result.success) {
    const where = result.error.issues.map((i) => `${i.path.join(".") || "profile"}: ${i.message}`).join("; ");
    throw new PiroProfileError(`PIRO profile is not valid: ${where}`);
  }
  const profile = result.data;
  for (const kind of PIRO_FILE_KINDS) {
    const pattern = profile.files[kind];
    if (pattern === undefined) continue;
    if (!profile.columns[kind]) throw new PiroProfileError(`PIRO profile: files.${kind} is set but columns.${kind} is not`);
    try {
      new RegExp(pattern, "i");
    } catch {
      throw new PiroProfileError(`PIRO profile: files.${kind} is not a valid pattern`);
    }
  }
  if (PIRO_FILE_KINDS.every((kind) => profile.files[kind] === undefined)) throw new PiroProfileError("PIRO profile: files must name job reports, casting reports or both");
  const casting = profile.columns.casting;
  if (casting && casting.issuedGrams === undefined && casting.issuedDwt === undefined) throw new PiroProfileError("PIRO profile: columns.casting needs issuedGrams or issuedDwt");
  for (const [label, status] of Object.entries(profile.statuses)) {
    if (label !== label.trim().toLowerCase()) throw new PiroProfileError(`PIRO profile: status label ${JSON.stringify(label)} must be lowercase and trimmed (mapped to ${status})`);
  }
  return profile;
}

/** Reads the column names listed in docs/integrations/piro.md. */
export const GENERIC_PIRO_PROFILE: PiroProfile = parsePiroProfile({
  id: "generic",
  name: "Generic PIRO reports",
  files: { jobs: String.raw`job|work.?order|manufactur`, casting: String.raw`cast|tree` },
  columns: {
    jobs: {
      jobId: ["Job No", "Job Number", "Job #", "Job ID", "Job", "Work Order"],
      status: ["Status", "Job Status"],
      updatedDate: ["Last Updated", "Updated", "Modified", "Status Date"],
      stage: ["Department", "Stage", "Process", "Current Process", "Location"],
      styleNumber: ["Style No", "Style Number", "Style #", "Design No", "Design"],
      sku: ["SKU", "Item No", "Item Number", "Stock No"],
      orderNumber: ["Order No", "Order Number", "Order #", "Sales Order", "PO No"],
      metal: ["Metal", "Metal Type"],
      karat: ["Karat", "Kt", "Purity", "Metal Purity"],
      quantity: ["Qty", "Quantity", "Pcs", "Pieces"],
      dueDate: ["Due Date", "Due", "Promise Date", "Delivery Date"],
      startDate: ["Start Date", "Started", "Created", "Job Date"],
      completedDate: ["Completed Date", "Completed", "Finished", "Close Date"],
      estimatedGrams: ["Est Weight (g)", "Estimated Grams", "Est Grams", "Estimated Weight (g)"],
      estimatedDwt: ["Est Weight (dwt)", "Estimated DWT", "Est DWT"],
      actualGrams: ["Actual Weight (g)", "Actual Grams", "Net Weight (g)", "Finished Weight (g)"],
      actualDwt: ["Actual Weight (dwt)", "Actual DWT", "Net Weight (dwt)", "Finished Weight (dwt)"],
      treeId: ["Tree No", "Tree Number", "Tree #", "Casting Tree"],
    },
    casting: {
      treeId: ["Tree No", "Tree Number", "Tree #", "Tree ID", "Tree", "Casting Tree"],
      castDate: ["Cast Date", "Casting Date", "Date"],
      metal: ["Metal", "Metal Type"],
      karat: ["Karat", "Kt", "Purity", "Metal Purity"],
      status: ["Status"],
      issuedGrams: ["Issued Weight (g)", "Metal Issued (g)", "Issued Grams", "Issue Weight", "Metal In (g)"],
      issuedDwt: ["Issued Weight (dwt)", "Metal Issued (dwt)", "Issued DWT", "Metal In (dwt)"],
      returnedGrams: ["Returned Weight (g)", "Received Weight (g)", "Returned Grams", "Metal Out (g)", "Total Return (g)"],
      returnedDwt: ["Returned Weight (dwt)", "Received Weight (dwt)", "Returned DWT", "Metal Out (dwt)"],
      castingsGrams: ["Castings Weight (g)", "Casting Weight (g)", "Pieces Weight (g)"],
      castingsDwt: ["Castings Weight (dwt)", "Casting Weight (dwt)", "Pieces Weight (dwt)"],
      scrapGrams: ["Scrap Weight (g)", "Button Weight (g)", "Sprue Weight (g)", "Scrap (g)"],
      scrapDwt: ["Scrap Weight (dwt)", "Button Weight (dwt)", "Sprue Weight (dwt)", "Scrap (dwt)"],
      jobs: ["Jobs", "Job Numbers", "Job Nos", "Job No"],
    },
  },
});

/**
 * The profile the PIRO_MAPPING_PROFILE setting names: "generic", or a path
 * to a profile JSON file kept in the client's private instance repo.
 */
export async function resolvePiroProfile(setting: string | undefined, read: (path: string) => Promise<string> = (p) => readFile(p, "utf8")): Promise<PiroProfile> {
  const value = setting?.trim() ?? "";
  if (value === "" || value === "generic") return GENERIC_PIRO_PROFILE;
  let json: unknown;
  try {
    json = JSON.parse(await read(value));
  } catch (error) {
    throw new PiroProfileError(`PIRO_MAPPING_PROFILE: could not read a JSON profile (${error instanceof Error ? error.name : "error"})`);
  }
  return parsePiroProfile(json);
}
