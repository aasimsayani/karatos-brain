import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * IDEX Online's Onsite feed API, built from IDEX's API pages: the natural
 * full feed and the lab-grown full file. Stones are synthetic, with made-up
 * item numbers, certificate numbers and prices.
 *
 * Docs facts the mock relies on:
 * - Each feed is a POST of JSON to its own address, with the key and secret
 *   in authentication_details and the file wanted in parameters: file_format
 *   csv (natural feed only), a data_format template, and create_zip_file,
 *   true unless set (api.idexonline.com/Onsite/FullFeed, .../LabGrownFullFile).
 * - Success is HTTP 200 with the file; an exception is HTTP 500 with
 *   result_info holding response_code and response_description (same pages).
 * - The header rows are as listed for format_20230628_extended and
 *   format_lg_20221130; the natural templates end with a blank column (same pages).
 * - A new natural file can be fetched every 2 hours, and lab-grown files are
 *   made every hour; before then the previous file comes back (same pages).
 */
const BASE = "https://api.idexonline.com";
const DOCS = `${BASE}/Onsite`;

/** format_20230628_extended, as IDEX lists it, ending with its blank column. */
export const IDEX_NATURAL_HEADERS = [
  "Item ID #", "Supplier Stock Ref.", "Cut", "Carat", "Color", "Natural Fancy Color", "Natural Fancy Color Intensity", "Natural Fancy Color Overtone", "Treated Color", "Clarity", "Cut Grade", "Grading Lab", "Certificate Number", "Certificate Path", "Image Path", "Online Report", "Video URL", "3DViewer URL", "Price Per Carat", "Total Price", "% Off IDEX List", "Polish", "Symmetry", "Measurements Length", "Measurements Width", "Measurements Height", "Depth", "Table", "Crown Height", "Crown Angle", "Pavilion Depth", "Pavilion Angle", "Girdle From", "Girdle To", "Culet Size", "Culet Condition", "Graining", "Fluorescence Intensity", "Fluorescence Color", "Enhancement", "Country", "State / Region", "Pair Stock Ref.", "Asking Price For Pair", "Shade", "Milky", "Black Inclusion", "Eye Clean", "Provenance Report", "Provenance Number", "Brand", "Guaranteed Availability", "",
];

/** format_lg_20221130, as IDEX lists it. */
export const IDEX_LAB_GROWN_HEADERS = [
  "Item ID", "Supplier Stock Ref", "Cut", "Carat", "Color", "Natural Fancy Color", "Natural Fancy Color Intensity", "Natural Fancy Color Overtone", "Treated Color", "Clarity", "Cut Grade", "Grading Lab", "Certificate Number", "Certificate URL", "Image URL", "Online Report URL", "Polish", "Symmetry", "Price Per Carat", "Total Price", "Measurements Length", "Measurements Width", "Measurements Height", "Depth", "Table", "Crown Height", "Crown Angle", "Pavilion Depth", "Pavilion Angle", "Girdle From", "Girdle To", "Culet Size", "Culet Condition", "Graining", "Fluorescence Intensity", "Fluorescence Color", "Enhancement", "Country Code", "Country Name", "State Code", "State Name", "Pair Stock Ref", "Pair Separable", "Asking Price Per Carat For Pair", "Shade", "Milky", "Black Inclusion", "Eye Clean", "Provenance Report", "Provenance Number", "Brand", "Availability", "Video URL", "3DViewer URL",
];

/** A stone as a feed row, by header name. Missing columns are blank. */
export type IdexMockStone = Record<string, string>;

export const idexStone = fixtureBuilder<IdexMockStone>((n) => ({
  "Item ID #": String(900000 + n),
  "Supplier Stock Ref.": `TEST-${n}`,
  Cut: "Round",
  Carat: "1.01",
  Color: "G",
  Clarity: "VS1",
  "Cut Grade": "Excellent",
  "Grading Lab": "GIA",
  "Certificate Number": `TESTCERT${n}`,
  "Certificate Path": `https://example.test/idex/cert-${n}.pdf`,
  "Image Path": `https://example.test/idex/${n}.jpg`,
  "Price Per Carat": `${4000 + n * 10}.00`,
  "Total Price": (1.01 * (4000 + n * 10)).toFixed(2),
  "% Off IDEX List": "-12.5",
  Polish: "Excellent",
  Symmetry: "Very Good",
  "Measurements Length": "6.42",
  "Measurements Width": "6.45",
  "Measurements Height": "3.98",
  Depth: "61.8",
  Table: "57",
  "Girdle From": "Medium",
  "Girdle To": "Slightly Thick",
  "Culet Size": "None",
  "Fluorescence Intensity": "Faint",
  "Fluorescence Color": "Blue",
  Country: "USA",
  "State / Region": "New York",
  "Eye Clean": "Yes",
  "Guaranteed Availability": "Yes",
}));

/** Writes rows under a header line, quoting values as CSV does. */
export function idexCsv(headers: readonly string[], stones: readonly IdexMockStone[]): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [headers.map(cell).join(","), ...stones.map((s) => headers.map((h) => cell(s[h] ?? "")).join(","))].join("\r\n") + "\r\n";
}

export interface IdexMockData {
  apiKey: string;
  apiSecret: string;
  /** Each feed's stones, or a file to answer as written. A feed left out answers the IDEX error for a service not on the subscription. */
  feeds: { natural?: IdexMockStone[] | string; lab_grown?: IdexMockStone[] | string };
  /** The next this many requests answer 429. */
  throttle?: number;
}

export interface IdexMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Every feed answered, in order: natural or lab_grown, with the parameters asked for. */
  readonly operations: { feed: string; parameters: Record<string, unknown> }[];
}

const failure = (code: number, description: string): DocMockResponse => ({ status: 500, body: { result_info: { response_code: code, response_description: description } } });

export function idexDocMock(data: IdexMockData): IdexMock {
  const operations: { feed: string; parameters: Record<string, unknown> }[] = [];
  let throttle = data.throttle ?? 0;

  const feed = (name: "natural" | "lab_grown", headers: readonly string[], template: string) => ({
    method: "POST" as const,
    path: name === "natural" ? "/onsite/api/fullfeed" : "/onsite/api/labgrownfullfile",
    documentedAt: name === "natural" ? `${DOCS}/FullFeed` : `${DOCS}/LabGrownFullFile`,
    respond(request: { body: string; headers: Headers }): DocMockResponse {
      if (throttle > 0) {
        throttle--;
        return { status: 429, body: { message: "Too Many Requests" }, headers: { "retry-after": "2" } };
      }
      let body: { authentication_details?: { api_key?: unknown; api_secret?: unknown }; parameters?: Record<string, unknown> };
      try {
        body = JSON.parse(request.body) as typeof body;
      } catch {
        return failure(10001, "The request body could not be read.");
      }
      const parameters = body.parameters ?? {};
      operations.push({ feed: name, parameters });
      if (body.authentication_details?.api_key !== data.apiKey || body.authentication_details?.api_secret !== data.apiSecret) return failure(32110, "Invalid authentication details.");
      if (parameters.data_format !== template) return failure(32120, "Unknown data format.");
      if (name === "natural" && parameters.file_format !== "csv") return failure(32130, "Unknown file format.");
      if (parameters.create_zip_file !== false) throw new Error("the IDEX mock only answers unzipped files; ask with create_zip_file false");
      const file = data.feeds[name];
      if (file === undefined) return failure(32140, "This service is not part of the subscription.");
      return { status: 200, text: typeof file === "string" ? file : idexCsv(headers, file), headers: { "content-type": "text/csv", "content-disposition": `attachment; filename=${name}.csv` } };
    },
  });

  const api = checkDocMock({
    integration: "idex",
    baseUrl: BASE,
    source: { url: `${DOCS}/FullFeed`, title: "IDEX Onsite API - Full Feed", retrievedOn: "2026-10-25", version: "format_20230628_extended and format_lg_20221130" },
    assumptions: [
      "Values are comma-separated, quoted only when they hold a comma, quote or line break",
      "Price Per Carat and Total Price are US dollars, after the markups set on IDEX",
      "Wrong credentials and a feed not on the subscription answer HTTP 500 with result_info",
      "Throttling answers 429 with Retry-After",
    ],
    routes: [feed("natural", IDEX_NATURAL_HEADERS, "format_20230628_extended"), feed("lab_grown", IDEX_LAB_GROWN_HEADERS, "format_lg_20221130")],
  });

  return {
    api,
    fetch: docMockFetch(api),
    get operations() {
      return operations;
    },
  };
}

export default {
  integration: "idex",
  covers: "IDEX's Onsite feeds: the natural full feed and the lab-grown full file",
  watchPages: [`${DOCS}/FullFeed`, `${DOCS}/LabGrownFullFile`],
  docMocks: () => [idexDocMock({ apiKey: "", apiSecret: "", feeds: {} }).api],
} satisfies DocMockModule;
