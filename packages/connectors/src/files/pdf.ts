import { getDocument, PasswordException } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * Reads the text of a PDF as lines, in reading order, for statement parsers.
 * Text pieces on one baseline become one line; a gap wider than a couple of
 * characters becomes two spaces, so table columns stay apart. PDFs come from
 * outside, so the reader renders no forms, loads no fonts, and refuses
 * files over a size or page limit. The pdf.js version pinned here has no
 * code path that evaluates code from a PDF.
 */

export interface PdfLine {
  /** Page number, from 1. */
  page: number;
  /** Line number on its page, from 1, top to bottom. */
  line: number;
  text: string;
}

export interface PdfLimits {
  maxBytes?: number;
  maxPages?: number;
}

export class PdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfError";
  }
}

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_PAGES = 300;

/** A run of text and where it sits on the page, in points. */
export interface PdfPiece {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
}

/** Pieces whose baselines are this close (in points) share a line. */
const SAME_LINE = 2;

/** Groups pieces into lines, top to bottom, left to right. Exported for tests: pdf.js often merges pieces itself. */
export function linesOf(pieces: PdfPiece[]): string[] {
  const rows: PdfPiece[][] = [];
  // Top to bottom, then left to right.
  for (const piece of [...pieces].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.at(-1);
    if (row && Math.abs(row[0]!.y - piece.y) <= SAME_LINE) row.push(piece);
    else rows.push([piece]);
  }
  return rows
    .map((row) => {
      let text = "";
      let end: number | null = null;
      for (const piece of row.sort((a, b) => a.x - b.x)) {
        // A gap wider than about two characters is a column break.
        const charWidth = piece.text.length ? piece.width / piece.text.length : piece.height / 2;
        if (end !== null) text += piece.x - end > Math.max(2 * charWidth, 4) ? "  " : piece.x - end > charWidth / 4 ? " " : "";
        text += piece.text;
        end = piece.x + piece.width;
      }
      return text.replace(/[ \t]+$/, "").replace(/^\s+/, "").replace(/(\S) (?= \S)/g, "$1 ");
    })
    .filter((t) => t !== "");
}

export async function pdfLines(bytes: Uint8Array, limits: PdfLimits = {}): Promise<PdfLine[]> {
  const maxBytes = limits.maxBytes ?? MAX_PDF_BYTES;
  const maxPages = limits.maxPages ?? MAX_PDF_PAGES;
  if (bytes.byteLength > maxBytes) throw new PdfError(`is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
  // pdf.js takes ownership of the buffer it's given, so it gets a copy (and a plain Uint8Array, not a Buffer).
  const task = getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    stopAtErrors: true,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (error) {
    await task.destroy();
    if (error instanceof PasswordException) throw new PdfError("is password-protected; export it again without a password");
    throw new PdfError("is not a readable PDF");
  }
  try {
    if (doc.numPages > maxPages) throw new PdfError(`has ${doc.numPages} pages, more than the ${maxPages} allowed`);
    const out: PdfLine[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const pieces: PdfPiece[] = [];
      for (const item of content.items) {
        if (!("str" in item) || item.str.trim() === "") continue;
        pieces.push({ x: item.transform[4], y: item.transform[5], width: item.width, height: item.height, text: item.str });
      }
      linesOf(pieces).forEach((text, i) => out.push({ page: n, line: i + 1, text }));
      page.cleanup();
    }
    return out;
  } finally {
    await task.destroy();
  }
}
