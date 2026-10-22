import type { DocMock } from "../doc-mock.js";
import { quickBooksDocMock } from "./quickbooks.js";
import { slackDocMock } from "./slack.js";
import { stullerDocMock } from "./stuller.js";

/** Every doc-derived mock, with empty data, for checks and the vendor docs watch. */
export function allDocMocks(): DocMock[] {
  const quickbooks = quickBooksDocMock({ entities: {}, refreshToken: "", now: () => new Date(0) });
  return [stullerDocMock({ invoices: [], metalRates: [] }), quickbooks.oauth, quickbooks.api, slackDocMock({ channels: [], token: "" }).api];
}
