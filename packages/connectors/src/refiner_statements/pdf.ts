import type { PdfLine } from "../files/pdf.js";
import { settlementLine, type SettlementLine } from "./normalize.js";
import type { LineField, RefinerProfile } from "./profile.js";

/**
 * Reads the settlement lines in a PDF statement's text, with the layout the
 * refiner's profile gives. Refiners lay out their statements too
 * differently for one generic pattern to read them safely, so a PDF is read
 * only for a refiner whose profile has a layout, and otherwise the file is
 * named as unreadable instead of being guessed at. The lines this returns
 * are keyed like CSV lines, so a lot in both a CSV export and a PDF
 * statement is stored once.
 */

export class RefinerPdfLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefinerPdfLayoutError";
  }
}

export function pdfSettlementLines(lines: PdfLine[], profile: RefinerProfile, fileName: string): SettlementLine[] {
  const layout = profile.pdf;
  if (!layout) throw new RefinerPdfLayoutError(`the ${profile.name} profile has no PDF layout; export the statement as CSV or add a layout to the profile`);
  const patterns = (typeof layout.line === "string" ? [layout.line] : layout.line).map((p) => new RegExp(p, "i"));
  const ignore = layout.ignore.map((p) => new RegExp(p, "i"));
  const out: SettlementLine[] = [];
  for (const line of lines) {
    if (ignore.some((p) => p.test(line.text))) continue;
    const groups = patterns.map((p) => p.exec(line.text)?.groups).find((g) => g !== undefined);
    if (!groups) continue;
    out.push(settlementLine((field: LineField) => groups[field], `${fileName}:p${line.page}:${line.line}`, profile));
  }
  if (out.length === 0 && lines.length > 0) throw new RefinerPdfLayoutError("has no settlement lines the profile's PDF layout matches");
  return out;
}
