import { createHash } from "node:crypto";
import type { GiaReport } from "./client.js";

/**
 * Turns GIA reports into Brain A events. A report the lab found becomes
 * grading.report_retrieved, with its grades, measurements and proportions,
 * keyed by the report number and its content, so a report GIA updates is a
 * new event and the same report read again is a duplicate. A report number
 * GIA doesn't know, or won't show this key, becomes
 * grading.report_unavailable once: a certificate number on a piece that GIA
 * can't confirm is worth a person's attention. Asset links are not stored,
 * since they expire an hour after the call; only which assets exist.
 */

export interface GiaEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);

/** "1.01 carat" or "0.50 ct" as a number of carats, or null. */
export function giaCarats(value: unknown): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(?:carats?|ct|cts)?\.?$/i.exec(text(value) ?? "");
  return m ? Number(m[1]) : null;
}

/** The report's date as an ISO time: report_date_iso when it is one, else report_date such as "March 13, 2019". Null when neither reads. */
export function giaReportDate(report: GiaReport): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(report.report_date_iso) ?? "");
  if (iso) {
    const day = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    return day.toISOString().slice(0, 10) === iso[0] ? day.toISOString() : null;
  }
  const written = text(report.report_date);
  if (!written || !/^[A-Za-z]+ \d{1,2}, \d{4}$/.test(written)) return null;
  const t = Date.parse(`${written} 00:00:00 UTC`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const RESULT_KINDS: Record<string, string> = {
  DiamondGradingReportResults: "natural_diamond",
  LabGrownDiamondGradingReportResults: "lab_grown_diamond",
  PearlIdentReportResults: "pearl",
  IdentificationReportResults: "identification",
  MeleeServiceResults: "melee",
  NarrativeReportResults: "narrative",
  JewelryGradingReportResults: "jewelry",
  LabGrownQualityAssessmentResults: "lab_grown_diamond",
};

const PROPORTIONS = ["depth_pct", "table_pct", "crown_angle", "crown_height", "pavilion_angle", "pavilion_depth", "star_length", "lower_half", "girdle", "girdle_condition", "culet"] as const;
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function proportions(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const p = value as Record<string, unknown>;
  const out = Object.fromEntries(PROPORTIONS.flatMap((k) => (text(p[k]) ? [[camel(k), text(p[k])!]] : [])));
  return Object.keys(out).length ? out : undefined;
}

/** The report as an event. Its time is the report date; a report without one readable is dead-lettered. */
export function reportEvent(report: GiaReport, receivedAt: string): GiaEvent {
  const number = text(report.report_number) ?? "";
  const results = (typeof report.results === "object" && report.results !== null ? report.results : {}) as Record<string, unknown>;
  const typename = text(results.__typename);
  const assets = Array.isArray(report.assets) ? (report.assets as Record<string, unknown>[]) : [];
  const key = `gia:report:${number}:${short({ ...report, quota: undefined })}`;
  return {
    id: key.replace(/[^A-Za-z0-9_.:-]/g, "_").replace(/^gia:/, "gia_"),
    type: "grading.report_retrieved",
    occurredAt: number ? (giaReportDate(report) ?? undefined) : undefined,
    receivedAt,
    idempotencyKey: key,
    payload: {
      lab: "GIA",
      reportNumber: number,
      reportType: text(report.report_type),
      reportTypeCode: text(report.report_type_code),
      kind: (typename && RESULT_KINDS[typename]) ?? "other",
      digital: report.is_digital === true,
      shape: text(results.shape_and_cutting_style),
      measurements: text(results.measurements),
      caratWeight: giaCarats(results.carat_weight),
      color: text(results.color_grade),
      colorOrigin: text(results.color_origin),
      clarity: text(results.clarity_grade),
      cut: text(results.cut_grade),
      polish: text(results.polish),
      symmetry: text(results.symmetry),
      fluorescence: text(results.fluorescence),
      inscriptions: text(results.inscriptions),
      comments: text(results.report_comments),
      countryOfOrigin: text(results.country_of_origin),
      diamondType: text(results.diamond_type),
      labGrownIdentification: text(results.identification),
      proportions: proportions(results.proportions),
      assets: assets.flatMap((a) => (text(a.asset_type_code) ? [{ code: text(a.asset_type_code)!, description: text(a.asset_type_description) }] : [])),
      note: text(report.info_message),
    },
  };
}

/** A report number GIA can't confirm, once per number and reason. Its time is when it was looked up. */
export function unavailableEvent(reportNumber: string, reason: "not_found" | "not_permitted", receivedAt: string): GiaEvent {
  const key = `gia:unavailable:${reportNumber}:${reason}`;
  return {
    id: key.replace(/^gia:/, "gia_"),
    type: "grading.report_unavailable",
    occurredAt: receivedAt,
    receivedAt,
    idempotencyKey: key,
    payload: { lab: "GIA", reportNumber, reason },
  };
}

/**
 * The report numbers in a list file: one per line, first comma-separated
 * field, blank lines and lines starting with # skipped. Throws naming the
 * lines that hold something else, never their contents.
 */
export function parseReportNumbers(source: string, pattern: RegExp): string[] {
  const numbers: string[] = [];
  const bad: number[] = [];
  source
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .forEach((line, i) => {
      const value = line.split(",")[0]!.trim().replace(/^"|"$/g, "").toUpperCase();
      if (value === "" || line.trim().startsWith("#")) return;
      if (pattern.test(value)) numbers.push(value);
      else bad.push(i + 1);
    });
  if (bad.length) throw new Error(`report number list: line ${bad.slice(0, 10).join(", ")}${bad.length > 10 ? " and more" : ""} ${bad.length === 1 ? "is" : "are"} not a report number`);
  return [...new Set(numbers)];
}
