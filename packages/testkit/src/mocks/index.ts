import type { DocMock } from "../doc-mock.js";
import { stullerDocMock } from "./stuller.js";

/** Every doc-derived mock, with empty data, for checks and the vendor docs watch. */
export function allDocMocks(): DocMock[] {
  return [stullerDocMock({ invoices: [], metalRates: [] })];
}
