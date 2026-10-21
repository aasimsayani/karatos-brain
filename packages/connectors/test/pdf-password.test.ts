import { describe, expect, it, vi } from "vitest";

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", async (original) => {
  const real = await original<typeof import("pdfjs-dist/legacy/build/pdf.mjs")>();
  return {
    ...real,
    getDocument: () => ({ promise: Promise.reject(new real.PasswordException("No password given", 1)), destroy: async () => {} }),
  };
});

const { pdfLines, PdfError } = await import("../src/files/pdf.js");

describe("password-protected PDFs", () => {
  it("asks for the statement again without a password", async () => {
    await expect(pdfLines(new TextEncoder().encode("%PDF-1.4"))).rejects.toThrow(new PdfError("is password-protected; export it again without a password"));
  });
});
