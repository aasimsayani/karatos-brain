import type { DocMock } from "../doc-mock.js";
import { googleWorkspaceDocMock } from "./google_workspace.js";
import { quickBooksDocMock } from "./quickbooks.js";
import { stullerDocMock } from "./stuller.js";

/** Every doc-derived mock, with empty data, for checks and the vendor docs watch. */
export function allDocMocks(): DocMock[] {
  const quickbooks = quickBooksDocMock({ entities: {}, refreshToken: "", now: () => new Date(0) });
  const google = googleWorkspaceDocMock({ files: [], refreshToken: "" });
  return [stullerDocMock({ invoices: [], metalRates: [] }), quickbooks.oauth, quickbooks.api, google.oauth, google.drive, google.sheets, google.calendar];
}
