import type { DocMock } from "../doc-mock.js";
import { plaidDocMock } from "./plaid.js";
import { quickBooksDocMock } from "./quickbooks.js";
import { stullerDocMock } from "./stuller.js";
import { typeformDocMock } from "./typeform.js";
import { xeroDocMock } from "./xero.js";

/** Every doc-derived mock, with empty data, for checks and the vendor docs watch. */
export function allDocMocks(): DocMock[] {
  const quickbooks = quickBooksDocMock({ entities: {}, refreshToken: "", now: () => new Date(0) });
  const plaid = plaidDocMock({ clientId: "", secret: "", accessToken: "", itemId: "", accounts: [], changes: [] });
  const xero = xeroDocMock({ records: {}, refreshToken: "" });
  return [stullerDocMock({ invoices: [], metalRates: [] }), quickbooks.oauth, quickbooks.api, typeformDocMock({ forms: {}, accessToken: "" }).api, xero.identity, xero.api, plaid.api];
}
