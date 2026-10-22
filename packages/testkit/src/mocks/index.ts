import type { DocMock } from "../doc-mock.js";
import { hubSpotDocMock } from "./hubspot.js";
import { quickBooksDocMock } from "./quickbooks.js";
import { stullerDocMock } from "./stuller.js";

/** Every doc-derived mock, with empty data, for checks and the vendor docs watch. */
export function allDocMocks(): DocMock[] {
  const quickbooks = quickBooksDocMock({ entities: {}, refreshToken: "", now: () => new Date(0) });
  return [stullerDocMock({ invoices: [], metalRates: [] }), quickbooks.oauth, quickbooks.api, hubSpotDocMock({ records: {}, accessToken: "" }).api];
}
