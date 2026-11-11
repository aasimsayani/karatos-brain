import { createHash } from "node:crypto";
import { at, textAt, type XmlElement } from "./xml.js";

/**
 * Turns HRD Antwerp reports into Brain A events, in the same types the GIA
 * connector emits. A report HRD found becomes grading.report_retrieved,
 * with its grades, measurements and proportions for a diamond, its metal
 * and stones for a jewel, and its specification for a star or melee
 * parcel. It is keyed by the report number and a hash of what is kept, so
 * a report HRD changes is a new event and the same one read again is a
 * duplicate. A number HRD has no report for, and a report HRD no longer
 * lists as valid, become grading.report_unavailable once each. PDF links
 * are not kept: they need the token to open. Only which reports exist.
 */

export interface HrdEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);

/** "1.00 ct" or "0.5" as a number of carats, or null. */
export function hrdCarats(value: string | undefined): number | null {
  const m = /^(\d{1,4}(?:\.\d{1,4})?)\s*(?:ct|cts|carats?)?$/i.exec(value ?? "");
  return m ? Number(m[1]) : null;
}

/** A YYYY-MM-DD date that is a real day, as an ISO time; null otherwise. */
export function hrdDate(value: string | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");
  if (!m) return null;
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return day.toISOString().slice(0, 10) === m[0] ? day.toISOString() : null;
}

const percent = (value: string | undefined) => (value && /^\d{1,3}(\.\d{1,3})?$/.test(value) ? Number(value) : undefined);

/** A grade HRD writes as a code, a description and an index: the description, else the code. */
function grade(node: XmlElement | undefined, prefix: string): string | undefined {
  return textAt(node, `${prefix}Description`) ?? textAt(node, `${prefix}Code`) ?? textAt(node, "Description") ?? textAt(node, "Code");
}

/** Drops what didn't read, so the payload and its hash hold only what HRD sent. */
const kept = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

/** The first report type HRD lists for the number, with its issue date. */
function available(report: XmlElement): { code: string | undefined; type: string | undefined; issued: string | undefined } {
  const first = at(report, "AvailableReports")?.children[0];
  return { code: first?.name, type: textAt(first, "ReportType"), issued: textAt(first, "DateOfIssue") };
}

function kindOf(code: string | undefined, origin: string | undefined, jewel: boolean): string {
  if (jewel) return "jewelry";
  if (code?.toUpperCase() === "SM") return "melee";
  if (origin && /lab|synthetic|grown/i.test(origin)) return "lab_grown_diamond";
  if (origin && /natural/i.test(origin)) return "natural_diamond";
  return "other";
}

function diamond(report: XmlElement): Record<string, unknown> {
  const results = at(report, "Results|Result");
  const extra = at(report, "AdditionalInformation");
  const cut = at(results, "Cut");
  const proportions = kept({
    depthPct: percent(textAt(report, "TotalDepth", "TotalDepthPercent") ?? textAt(results, "TotalDepth", "TotalDepthPercent")),
    tablePct: percent(textAt(report, "TableWidth", "TableWidthPercent") ?? textAt(results, "TableWidth", "TableWidthPercent")),
    crownHeightPct: percent(textAt(report, "CrownHeight", "CrownHeightPercent")),
    crownAngle: percent(textAt(report, "CrownHeight", "CrownAngle|CrownHeightAngle")),
    pavilionDepthPct: percent(textAt(report, "PavilionDepth", "PavilionDepthPercent")),
    pavilionAngle: percent(textAt(report, "PavilionDepth", "PavilionAngle")),
    girdle: textAt(extra, "Girdle", "GirdleDescription") ?? textAt(extra, "Girdle", "GirdleEval"),
    culet: textAt(extra, "Culet", "CuletDescription") ?? textAt(extra, "Culet", "CuletEval"),
  });
  return {
    shape: textAt(results, "Shape", "ShapeCode"),
    caratWeight: hrdCarats(textAt(results, "Carat")),
    color: grade(at(results, "ColourGrade"), "Colour"),
    clarity: grade(at(results, "ClarityGrade"), "Clarity"),
    cut: grade(at(cut, "Proportions"), "Proportions"),
    polish: grade(at(cut, "Polish"), "Polish"),
    symmetry: grade(at(cut, "Symmetry"), "Symmetry"),
    fluorescence: grade(at(extra, "Fluorescence"), "Fluorescence"),
    measurements: textAt(extra, "Measurements"),
    inscriptions: textAt(report, "Inscriptions") ?? textAt(extra, "Inscriptions"),
    comments: textAt(report, "Remarks") ?? textAt(report, "Remark"),
    heartsAndArrows: textAt(report, "HeartsAndArrows") ?? textAt(extra, "HeartsAndArrows"),
    origin: textAt(report, "Origin"),
    specification: kept({
      fluorescence: textAt(results, "Specifications", "Fluorescence"),
      color: textAt(results, "Specifications", "Colour"),
      clarity: textAt(results, "Specifications", "Clarity"),
    }),
    proportions: Object.keys(proportions).length ? proportions : undefined,
  };
}

function jewel(report: XmlElement): Record<string, unknown> {
  const stones = (at(report, "Details|Detail")?.children ?? []).map((item) =>
    kept({
      quantity: /^\d{1,6}$/.test(textAt(item, "Quantity") ?? "") ? Number(textAt(item, "Quantity")) : undefined,
      shape: textAt(item, "Shape"),
      color: textAt(item, "ColourGrade"),
      clarity: textAt(item, "ClarityGrade"),
      setting: textAt(item, "Setting"),
      totalCarats: hrdCarats(textAt(item, "CaratData", "Total") ?? textAt(item, "Carat")),
    }),
  );
  const count = textAt(report, "AmountDiamonds", "Value");
  return {
    jewelType: textAt(report, "JewelType", "Value"),
    metal: textAt(report, "PreciousMetal", "Value"),
    diamondCount: count && /^\d{1,6}$/.test(count) ? Number(count) : undefined,
    caratWeight: hrdCarats(textAt(report, "WeightDiamonds", "Value")),
    description: textAt(report, "Description", "Value"),
    comments: textAt(report, "Remarks", "Value"),
    stones: stones.length ? stones : undefined,
    reportTypes: (at(report, "JewelReportTypes")?.children ?? []).map((c) => c.name.toUpperCase()).sort(),
  };
}

/** The report as an event. Its time is the issue date; a report without one that reads is dead-lettered. */
export function hrdReportEvent(report: XmlElement, receivedAt: string): HrdEvent {
  const number = textAt(report, "ReportNumber")?.toUpperCase() ?? "";
  const isJewel = at(report, "JewelType") !== undefined || at(report, "JewelReportTypes") !== undefined;
  const listed = available(report);
  const issued = hrdDate(isJewel ? textAt(report, "IssueDate") : listed.issued);
  const fields = isJewel ? jewel(report) : diamond(report);
  const spec = fields.specification as Record<string, unknown> | undefined;
  const payload = kept({
    lab: "HRD",
    reportNumber: number,
    reportType: listed.type,
    reportTypeCode: listed.code?.toUpperCase(),
    kind: kindOf(listed.code, fields.origin as string | undefined, isJewel),
    issuedOn: issued?.slice(0, 10),
    ...fields,
    specification: spec && Object.keys(spec).length ? spec : undefined,
  });
  const key = `hrd:report:${number}:${short(payload)}`;
  return {
    id: key.replace(/[^A-Za-z0-9_.:-]/g, "_").replace(/^hrd:/, "hrd_"),
    type: "grading.report_retrieved",
    occurredAt: number && issued ? issued : undefined,
    receivedAt,
    idempotencyKey: key,
    payload,
  };
}

/** A report number HRD can't confirm, once per number and reason. Its time is when it was found out. */
export function hrdUnavailableEvent(reportNumber: string, reason: "not_found" | "no_longer_valid", receivedAt: string): HrdEvent {
  const key = `hrd:unavailable:${reportNumber}:${reason}`;
  return {
    id: key.replace(/^hrd:/, "hrd_"),
    type: "grading.report_unavailable",
    occurredAt: receivedAt,
    receivedAt,
    idempotencyKey: key,
    payload: { lab: "HRD", reportNumber, reason },
  };
}
