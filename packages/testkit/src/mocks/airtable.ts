import { checkDocMock, type DocMock, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Airtable's Web API (v0) endpoints for the token's user, the bases a token
 * can see, a base's schema and a table's records, built from the API
 * reference. Data is synthetic. Like Airtable, the mock returns every field
 * of a record when the request names none, and only the named ones when it
 * does, so a test can show the connector never asks for a text field.
 */
const API = "https://api.airtable.com/v0";
const DOCS = "https://airtable.com/developers/web/api";

export interface AirtableMockField {
  id: string;
  name: string;
  type: string;
  options?: Record<string, unknown>;
}

export interface AirtableMockTable {
  id: string;
  name: string;
  primaryFieldId: string;
  fields: AirtableMockField[];
}

export interface AirtableMockRecord {
  id: string;
  createdTime: string;
  /** When a person last changed the record, for LAST_MODIFIED_TIME(). Defaults to createdTime. */
  lastModified?: string;
  /** Cell values by field name. Empty ones are left out of replies, as Airtable does. */
  fields: Record<string, unknown>;
}

export interface AirtableMockData {
  bases: { id: string; name: string; permissionLevel?: string }[];
  /** Tables by base id. */
  tables: Record<string, AirtableMockTable[]>;
  /** Records by table id. */
  records: Record<string, AirtableMockRecord[]>;
  /** The token the mock accepts. Any bearer token is accepted when absent. */
  token?: string;
  /** The scopes whoami reports, as it does for an OAuth token. Left out, as for a personal access token. */
  scopes?: string[];
  /** Rows per page the mock caps at, to exercise paging. Defaults to 100. */
  pageCap?: number;
  /** How many of the next requests answer 429. */
  rateLimited?: number;
  /** How many of the next records requests carrying an offset answer 422, as an expired iterator does. */
  expiredOffsets?: number;
}

const error = (status: number, type: string, message: string): DocMockResponse => ({ status, body: { error: { type, message } } });
const empty = (v: unknown) => v === undefined || v === null || v === "" || v === false || (Array.isArray(v) && v.length === 0);
const FORMULA = /^OR\(IS_AFTER\(LAST_MODIFIED_TIME\(\),'([^']+)'\),IS_AFTER\(CREATED_TIME\(\),'([^']+)'\)\)$/;

export function airtableDocMock(data: AirtableMockData): DocMock {
  const denied = (request: { headers: Headers }): DocMockResponse | null => {
    if (data.token !== undefined && request.headers.get("authorization") !== `Bearer ${data.token}`) return error(401, "AUTHENTICATION_REQUIRED", "Authentication required");
    if (data.rateLimited) {
      data.rateLimited--;
      return { status: 429, body: { errors: [{ error: "RATE_LIMIT_REACHED", message: "Rate limit exceeded. Please try again later" }] } };
    }
    return null;
  };
  const base = (id: string | undefined) => data.bases.find((b) => b.id === id);
  const noAccess = () => error(403, "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND", "Invalid permissions, or the requested model was not found. Check that both your user and your token have the required permissions, and that the model names and/or ids are correct.");
  /** Offsets look like Airtable's: an iterator id, then the record the page starts at. */
  const slice = <T>(rows: T[], url: URL, cap: number) => {
    const raw = url.searchParams.get("offset");
    const start = raw === null ? 0 : Number(/^itrPage(\d+)\/\w+$/.exec(raw)?.[1] ?? NaN);
    if (!Number.isInteger(start)) return null;
    const end = start + Math.min(cap, data.pageCap ?? cap);
    return { rows: rows.slice(start, end), next: end < rows.length ? `itrPage${end}/${(rows[end] as { id?: string }).id ?? "rec"}` : undefined };
  };
  return checkDocMock({
    integration: "airtable",
    baseUrl: API,
    source: { url: `${DOCS}/introduction`, title: "Airtable Web API reference", retrievedOn: "2026-11-06", version: "v0" },
    auth: "bearer",
    assumptions: [
      "whoami reports scopes for an OAuth token and leaves them out for a personal access token",
      "LAST_MODIFIED_TIME() with no field counts every change a person made to the record",
      "An expired records offset answers 422 LIST_RECORDS_ITERATOR_NOT_AVAILABLE",
      "Records come in the same order on each page, so an offset resumes where it left off",
      "A base the token can't read answers 403 rather than 404",
      "Field ids sent in fields[] are honored with returnFieldsByFieldId",
    ],
    routes: [
      {
        method: "GET",
        path: "/meta/whoami",
        documentedAt: `${DOCS}/get-user-id-scopes`,
        respond: (request) => denied(request) ?? { status: 200, body: { id: "usrTestUserxxxxxx", ...(data.scopes ? { scopes: data.scopes } : {}) } },
      },
      {
        method: "GET",
        path: "/meta/bases",
        documentedAt: `${DOCS}/list-bases`,
        respond(request) {
          const no = denied(request);
          if (no) return no;
          const page = slice(data.bases, request.url, 1000);
          if (!page) return error(422, "INVALID_OFFSET_VALUE", "The value of offset is invalid");
          return { status: 200, body: { bases: page.rows.map((b) => ({ permissionLevel: "read", ...b })), ...(page.next ? { offset: page.next } : {}) } };
        },
      },
      {
        method: "GET",
        path: "/meta/bases/{baseId}/tables",
        documentedAt: `${DOCS}/get-base-schema`,
        respond(request, params) {
          const no = denied(request);
          if (no) return no;
          if (!base(params.baseId)) return noAccess();
          return { status: 200, body: { tables: (data.tables[params.baseId!] ?? []).map((t) => ({ ...t, views: [{ id: "viwGridxxxxxxxxxx", name: "Grid view", type: "grid" }] })) } };
        },
      },
      {
        method: "GET",
        path: "/{baseId}/{tableIdOrName}",
        documentedAt: `${DOCS}/list-records`,
        respond(request, params) {
          const no = denied(request);
          if (no) return no;
          if (!base(params.baseId)) return noAccess();
          const table = (data.tables[params.baseId!] ?? []).find((t) => t.id === params.tableIdOrName || t.name === params.tableIdOrName);
          if (!table) return { status: 404, body: { error: "NOT_FOUND" } };
          const q = request.url.searchParams;
          const size = Number(q.get("pageSize") ?? 100);
          if (!Number.isInteger(size) || size < 1 || size > 100) return error(422, "INVALID_REQUEST_UNKNOWN", "Invalid request: parameter validation failed. Check your request data.");
          if (q.has("offset") && data.expiredOffsets) {
            data.expiredOffsets--;
            return error(422, "LIST_RECORDS_ITERATOR_NOT_AVAILABLE", "This iterator is no longer available. Please restart your request.");
          }
          let rows = data.records[table.id] ?? [];
          const formula = q.get("filterByFormula");
          if (formula !== null) {
            const m = FORMULA.exec(formula);
            if (!m || m[1] !== m[2] || Number.isNaN(Date.parse(m[1]!))) return error(422, "INVALID_FILTER_BY_FORMULA", "The formula for filtering records is invalid");
            const after = Date.parse(m[1]!);
            rows = rows.filter((r) => Date.parse(r.lastModified ?? r.createdTime) > after || Date.parse(r.createdTime) > after);
          }
          const asked = q.getAll("fields[]");
          const byId = q.get("returnFieldsByFieldId") === "true";
          for (const name of asked) if (!table.fields.some((f) => f.id === name || f.name === name)) return error(422, "UNKNOWN_FIELD_NAME", `Unknown field name: "${name}"`);
          // No fields named means every field, as Airtable does.
          const wanted = table.fields.filter((f) => asked.length === 0 || asked.includes(f.id) || asked.includes(f.name));
          const page = slice(rows, request.url, size);
          if (!page) return error(422, "INVALID_OFFSET_VALUE", "The value of offset is invalid");
          const records = page.rows.map((r) => ({
            id: r.id,
            createdTime: r.createdTime,
            fields: Object.fromEntries(wanted.filter((f) => !empty(r.fields[f.name])).map((f) => [byId ? f.id : f.name, r.fields[f.name]])),
          }));
          return { status: 200, body: { records, ...(page.next ? { offset: page.next } : {}) } };
        },
      },
    ],
  });
}

export default {
  integration: "airtable",
  covers: "Airtable's whoami, list bases, base schema and list records endpoints (Web API v0)",
  watchPages: [`${DOCS}/introduction`, `${DOCS}/get-user-id-scopes`, `${DOCS}/list-bases`, `${DOCS}/get-base-schema`, `${DOCS}/list-records`],
  docMocks: () => [airtableDocMock({ bases: [], tables: {}, records: {} })],
} satisfies DocMockModule;
