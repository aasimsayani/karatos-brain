import { createHash } from "node:crypto";
import { columnReader, type ColumnGetter, type ColumnMap } from "../files/columns.js";
import type { CsvRow } from "../files/csv.js";
import type { IdexFeed } from "./client.js";

/**
 * Turns IDEX Onsite feed rows into Brain A events. A stone that is new to
 * the feed, or whose grades or price changed, becomes
 * diamond_listing.listed with its grades, measurements and asking price,
 * keyed by its IDEX item number and a hash of what was read, so an
 * unchanged stone read again is a duplicate and a repriced one is new. A
 * stone that leaves the feed becomes diamond_listing.delisted.
 *
 * Media links aren't stored, only whether a certificate file, image, video
 * or 3D view exists: they point at supplier hosting KaratOS doesn't control.
 * A row that doesn't read (no item number, carat weight or price) is
 * dead-lettered with the line number and what was wrong.
 */

export interface IdexEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const IDEX_EVENT_TYPES = { listed: "diamond_listing.listed", delisted: "diamond_listing.delisted" } as const;

/** IDEX item numbers as the feeds write them. */
export const IDEX_ITEM_ID = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * The columns read, by the names the natural feed (format_20230628_extended)
 * and the lab-grown feed (format_lg_20221130) give them.
 */
export const IDEX_COLUMNS = {
  itemId: ["Item ID #", "Item ID"],
  stockRef: ["Supplier Stock Ref.", "Supplier Stock Ref"],
  shape: "Cut",
  carat: "Carat",
  color: "Color",
  fancyColor: "Natural Fancy Color",
  fancyIntensity: "Natural Fancy Color Intensity",
  fancyOvertone: "Natural Fancy Color Overtone",
  treatedColor: "Treated Color",
  clarity: "Clarity",
  cutGrade: ["Cut Grade", "Make (Cut Grade)"],
  lab: "Grading Lab",
  certificateNumber: "Certificate Number",
  certificateFile: ["Certificate Path", "Certificate URL"],
  image: ["Image Path", "Image URL"],
  video: "Video URL",
  viewer: "3DViewer URL",
  pricePerCarat: "Price Per Carat",
  totalPrice: "Total Price",
  offList: "% Off IDEX List",
  polish: "Polish",
  symmetry: "Symmetry",
  length: "Measurements Length",
  width: "Measurements Width",
  height: "Measurements Height",
  depth: "Depth",
  table: "Table",
  crownHeight: "Crown Height",
  crownAngle: "Crown Angle",
  pavilionDepth: "Pavilion Depth",
  pavilionAngle: "Pavilion Angle",
  girdleFrom: "Girdle From",
  girdleTo: "Girdle To",
  culetSize: "Culet Size",
  culetCondition: "Culet Condition",
  graining: "Graining",
  fluorescenceIntensity: "Fluorescence Intensity",
  fluorescenceColor: "Fluorescence Color",
  enhancement: "Enhancement",
  country: ["Country", "Country Name"],
  state: ["State / Region", "State Name"],
  pairStockRef: ["Pair Stock Ref.", "Pair Stock Ref"],
  shade: "Shade",
  milky: "Milky",
  blackInclusion: "Black Inclusion",
  eyeClean: "Eye Clean",
  provenanceReport: "Provenance Report",
  provenanceNumber: "Provenance Number",
  brand: "Brand",
  availability: ["Guaranteed Availability", "Availability"],
} satisfies ColumnMap;

/** Without these, no row means anything. */
export const IDEX_REQUIRED = ["itemId", "shape", "carat", "pricePerCarat", "totalPrice"];

export const idexColumns = (headers: string[], feed: IdexFeed): ColumnGetter => columnReader(headers, IDEX_COLUMNS, IDEX_REQUIRED, `the IDEX ${feed} feed`);

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);

/** A positive amount such as a weight or price: "1.01", "4,250.00". Null when it isn't one. */
export function idexAmount(value: string | undefined): number | null {
  const t = (value ?? "").trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 && Number.isFinite(n) ? n : null;
}

/** US dollars as whole cents, rounding half up. Trimmed to 12 digits first, so 1.005 is 101 cents and not 100.4999. */
export const idexCents = (usd: number) => Math.round(Number((usd * 100).toPrecision(12)));

/** A measurement or percentage that may be blank: a number, or null. Negative allowed for % off list. */
function signed(value: string | undefined): number | null {
  const t = (value ?? "").trim().replace(/%$/, "");
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

export type IdexRow = { kind: "stone"; itemId: string; hash: string; payload: Record<string, unknown> } | { kind: "unreadable"; line: number; problems: string[]; hash: string };

/** Reads one row: a stone, or the problems that stop it being one. */
export function readIdexRow(row: CsvRow, get: ColumnGetter, feed: IdexFeed): IdexRow {
  const value = (field: keyof typeof IDEX_COLUMNS) => {
    const v = get(row, field)?.trim();
    return v ? v : undefined;
  };
  const has = (field: keyof typeof IDEX_COLUMNS) => value(field) !== undefined;
  const problems: string[] = [];
  const itemId = value("itemId") ?? "";
  if (!IDEX_ITEM_ID.test(itemId)) problems.push("has no IDEX item number that reads");
  const carat = idexAmount(value("carat"));
  if (carat === null) problems.push("has no carat weight that reads");
  const perCarat = idexAmount(value("pricePerCarat"));
  if (perCarat === null) problems.push("has no price per carat that reads");
  const total = idexAmount(value("totalPrice"));
  if (total === null) problems.push("has no total price that reads");
  if (!has("shape")) problems.push("has no shape");
  if (problems.length) return { kind: "unreadable", line: row.line, problems, hash: short(row.values) };

  const payload: Record<string, unknown> = {
    source: "IDEX",
    feed,
    labGrown: feed === "lab_grown",
    itemId,
    supplierStockRef: value("stockRef"),
    shape: value("shape"),
    carat,
    color: value("color"),
    fancyColor: value("fancyColor") ? { color: value("fancyColor"), intensity: value("fancyIntensity"), overtone: value("fancyOvertone") } : undefined,
    treatedColor: value("treatedColor"),
    clarity: value("clarity"),
    cutGrade: value("cutGrade"),
    polish: value("polish"),
    symmetry: value("symmetry"),
    lab: value("lab"),
    certificateNumber: value("certificateNumber"),
    pricePerCaratCents: idexCents(perCarat!),
    totalPriceCents: idexCents(total!),
    currency: "USD",
    percentOffIdexList: signed(value("offList")),
    measurements: { length: signed(value("length")), width: signed(value("width")), height: signed(value("height")) },
    proportions: {
      depthPct: signed(value("depth")),
      tablePct: signed(value("table")),
      crownHeight: signed(value("crownHeight")),
      crownAngle: signed(value("crownAngle")),
      pavilionDepth: signed(value("pavilionDepth")),
      pavilionAngle: signed(value("pavilionAngle")),
      girdle: [value("girdleFrom"), value("girdleTo")].filter(Boolean).join(" to ") || undefined,
      culet: [value("culetSize"), value("culetCondition")].filter(Boolean).join(", ") || undefined,
    },
    fluorescence: [value("fluorescenceIntensity"), value("fluorescenceColor")].filter(Boolean).join(" ") || undefined,
    graining: value("graining"),
    enhancement: value("enhancement"),
    shade: value("shade"),
    milky: value("milky"),
    blackInclusion: value("blackInclusion"),
    eyeClean: value("eyeClean"),
    brand: value("brand"),
    provenance: value("provenanceReport") || value("provenanceNumber") ? { report: value("provenanceReport"), number: value("provenanceNumber") } : undefined,
    availability: value("availability"),
    pairStockRef: value("pairStockRef"),
    location: [value("state"), value("country")].filter(Boolean).join(", ") || undefined,
    media: { certificateFile: has("certificateFile"), image: has("image"), video: has("video"), view3d: has("viewer") },
  };
  return { kind: "stone", itemId, hash: short(payload), payload };
}

const idOf = (key: string) => key.replace(/^idex:/, "idex_");

/** A stone new to the feed or changed. `returns` counts the times it left the feed before, so a stone back unchanged is recorded again. */
export function listedEvent(feed: IdexFeed, stone: Extract<IdexRow, { kind: "stone" }>, returns: number, receivedAt: string): IdexEvent {
  const key = `idex:listed:${feed}:${stone.itemId}:${stone.hash}${returns ? `:${returns}` : ""}`;
  // A listing's time is when KaratOS saw it: the feed doesn't say when the stone was listed.
  return { id: idOf(key), type: IDEX_EVENT_TYPES.listed, occurredAt: receivedAt, receivedAt, idempotencyKey: key, payload: stone.payload };
}

/** A stone that left the feed for the `departure`th time, so each departure is recorded once. */
export function delistedEvent(feed: IdexFeed, itemId: string, departure: number, receivedAt: string): IdexEvent {
  const key = `idex:delisted:${feed}:${itemId}:${departure}`;
  return { id: idOf(key), type: IDEX_EVENT_TYPES.delisted, occurredAt: receivedAt, receivedAt, idempotencyKey: key, payload: { source: "IDEX", feed, itemId } };
}

/** A row that doesn't read, kept and dead-lettered with what was wrong. */
export function unreadableEvent(feed: IdexFeed, row: Extract<IdexRow, { kind: "unreadable" }>, receivedAt: string): IdexEvent {
  const key = `idex:unreadable:${feed}:${row.line}:${row.hash}`;
  return { id: idOf(key), type: IDEX_EVENT_TYPES.listed, occurredAt: undefined, receivedAt, idempotencyKey: key, payload: { source: "IDEX", feed, line: row.line, problems: row.problems } };
}
