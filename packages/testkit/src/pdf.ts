/**
 * Writes small, valid PDFs for connector tests, so statement fixtures are
 * made in the test from synthetic text instead of checked in as binaries.
 * Each page is a list of text pieces placed at x and y in points (the page
 * is 612 by 792, with y counted from the bottom), in Helvetica.
 */

export interface PdfText {
  x: number;
  y: number;
  text: string;
  size?: number;
}

const escape = (text: string) => text.replace(/[\\()]/g, (c) => `\\${c}`);

export function syntheticPdf(pages: PdfText[][]): Uint8Array {
  if (pages.length === 0) throw new Error("a PDF needs at least one page");
  for (const piece of pages.flat()) {
    if (!/^[\x20-\x7e]*$/.test(piece.text)) throw new Error(`syntheticPdf writes printable ASCII only: ${JSON.stringify(piece.text)}`);
  }
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const contents = pages.map((page) => {
    const stream = page.map((p) => `BT /F1 ${p.size ?? 10} Tf ${p.x} ${p.y} Td (${escape(p.text)}) Tj ET`).join("\n");
    return add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  const parent = objects.length + pages.length + 1;
  const kids = contents.map((c) => add(`<< /Type /Page /Parent ${parent} 0 R /MediaBox [0 0 612 792] /Contents ${c} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
  add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${parent} 0 R >>`);

  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** Lays out statement rows as columns, top to bottom, one row every 14 points. Each row is a list of [x, text] cells. */
export function statementPage(rows: [number, string][][], top = 740): PdfText[] {
  return rows.flatMap((cells, i) => cells.map(([x, text]) => ({ x, y: top - i * 14, text })));
}
