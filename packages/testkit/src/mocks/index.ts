import type { DocMock } from "../doc-mock.js";
import { mondayDocMock } from "./monday.js";
import { quickBooksDocMock } from "./quickbooks.js";
import { stullerDocMock } from "./stuller.js";

/** Every doc-derived mock, with empty data, for checks and the vendor docs watch. */
export function allDocMocks(): DocMock[] {
  const quickbooks = quickBooksDocMock({ entities: {}, refreshToken: "", now: () => new Date(0) });
  const monday = mondayDocMock({ token: "", boards: [], items: [], now: () => new Date(0) });
  return [stullerDocMock({ invoices: [], metalRates: [] }), quickbooks.oauth, quickbooks.api, monday.api];
}
