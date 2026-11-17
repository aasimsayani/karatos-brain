import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Deputy's Resource API, built from developer.deputy.com. Data is
 * synthetic. Deputy offers a free trial; until a trial install is set up,
 * this mock stands in, and a trial run confirms it.
 *
 * Docs facts the mock relies on:
 * - Each install is at https://{install}.{geo}.deputy.com, and a request
 *   carries `Authorization: Bearer <token>`, a permanent token from a
 *   Client ID page (permanent-token).
 * - Reads use POST /api/v1/resource/{Object}/QUERY, "always POST even if
 *   you are only retrieving data" (resource-api), with a body of search
 *   (clauses s1, s2… each {field, data, type}), sort ({field: asc|desc}),
 *   start (offset, default 0) and max (1 to 500, default 100), all
 *   optional (search-roster).
 * - The answer is a JSON array of records (timesheets).
 * - Roster, Timesheet, Employee, OperationalUnit and Leave fields are as
 *   their object pages list them (roster, timesheet, employee, area,
 *   leave); StartTime and EndTime are Unix seconds, Modified an ISO time
 *   with the install's offset.
 */
const DOCS = {
  permanentToken: "https://developer.deputy.com/docs/using-a-permanent-token",
  resourceApi: "https://developer.deputy.com/docs/getting-data-resources-api",
  searchRoster: "https://developer.deputy.com/reference/searchroster-1",
  timesheets: "https://developer.deputy.com/docs/retrieving-timesheets-from-deputy",
} as const;
export const DEPUTY_DOC_PAGES = DOCS;

export type DeputyMockRecord = Record<string, unknown>;

export interface DeputyMockData {
  token: string;
  /** Records by object name: Company, OperationalUnit, Employee, Roster, Timesheet, Leave. */
  records: Record<string, DeputyMockRecord[]>;
  /** 429s to answer before the next reads. */
  rateLimits?: number;
  /** Base URL: https://example.na.deputy.com unless a test says otherwise. */
  baseUrl?: string;
}

const OBJECTS = new Set(["Company", "OperationalUnit", "Employee", "Roster", "Timesheet", "Leave"]);
const TYPES = new Set(["eq", "ne", "gt", "ge", "lt", "le"]);
/** A time `n` hours into 2026, as Deputy writes Modified, at a US Central offset. */
const modified = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 3_600_000 - 6 * 3_600_000).toISOString().replace(".000Z", "-06:00");
const unix = (n: number) => Date.UTC(2026, 0, 1) / 1000 + n * 3600;

/** A location, the store. */
export const deputyCompany = fixtureBuilder<DeputyMockRecord>((n) => ({ Id: n, Portfolio: null, Code: `S${n}`, Active: true, ParentCompany: 0, CompanyName: `Test Store ${n}`, TradingName: null, BusinessNumber: null, IsWorkplace: true, IsPayrollEntity: true, Address: 9, Contact: 9, Created: modified(0), Modified: modified(n) }));

/** An area of location 1, the sales floor or the bench. */
export const deputyArea = fixtureBuilder<DeputyMockRecord>((n) => ({ Id: n, Company: 1, WorkType: null, Parent: 0, OperationalUnitName: n % 2 ? "Sales floor" : "Bench", Active: true, PayrollExportName: `A${n}`, Address: 0, Contact: 0, RosterSortOrder: n, ShowOnRoster: true, Colour: "#000000", OperationalUnitType: 0, Creator: 1, Created: modified(0), Modified: modified(n) }));

/** A team member at location 1, with the personal details Deputy holds. */
export const deputyEmployee = fixtureBuilder<DeputyMockRecord>((n) => ({
  Id: n,
  Company: 1,
  FirstName: "Test",
  LastName: `Member ${n}`,
  DisplayName: `Test Member ${n}`,
  DateOfBirth: "1990-01-01",
  Gender: 0,
  Pronouns: 0,
  MainAddress: 9,
  Contact: 9,
  Photo: 0,
  User: n,
  Active: true,
  StartDate: "2024-03-01T00:00:00-06:00",
  TerminationDate: null,
  Role: 50,
  Creator: 1,
  Created: modified(0),
  Modified: modified(n),
}));

/** An eight-hour published shift for team member 1 on the sales floor, `n` days into 2026, $160. */
export const deputyRoster = fixtureBuilder<DeputyMockRecord>((n) => ({
  Id: n,
  Date: `${new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().slice(0, 10)}T00:00:00-06:00`,
  StartTime: unix(n * 24 + 15),
  EndTime: unix(n * 24 + 23),
  Mealbreak: "1970-01-01T00:30:00-06:00",
  TotalTime: 7.5,
  Cost: 160,
  OperationalUnit: 1,
  Employee: 1,
  Comment: "Cover the bridal case",
  Warning: "",
  Published: true,
  MatchedByTimesheet: n,
  Open: false,
  ApprovalRequired: false,
  ConfirmStatus: 2,
  Creator: 1,
  Created: modified(n * 24 - 48),
  Modified: modified(n * 24 - 24),
}));

/** The timesheet worked for shift `n`, approved, $165.25. */
export const deputyTimesheet = fixtureBuilder<DeputyMockRecord>((n) => ({
  Id: n,
  Employee: 1,
  Date: `${new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().slice(0, 10)}T00:00:00-06:00`,
  StartTime: unix(n * 24 + 15),
  EndTime: unix(n * 24 + 23),
  Mealbreak: "1970-01-01T00:30:00-06:00",
  TotalTime: 7.75,
  Cost: "165.25",
  Roster: n,
  EmployeeComment: "Stayed late for a customer",
  Disputed: false,
  TimeApproved: true,
  TimeApprover: 2,
  Discarded: false,
  ValidationFlag: 0,
  OperationalUnit: 1,
  IsInProgress: false,
  IsLeave: false,
  LeaveId: null,
  PayRuleApproved: true,
  Exported: false,
  PayStaged: false,
  Creator: 1,
  Created: modified(n * 24 + 23),
  Modified: modified(n * 24 + 24),
}));

/** Two days of approved leave for team member 1, starting `n` days into 2026. */
export const deputyLeave = fixtureBuilder<DeputyMockRecord>((n) => ({
  Id: n,
  Employee: 1,
  EmployeeHistory: 1,
  Company: 1,
  LeaveRule: 3,
  DateStart: new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().slice(0, 10),
  DateEnd: new Date(Date.UTC(2026, 0, 2) + n * 86_400_000).toISOString().slice(0, 10),
  Days: 2,
  Comment: "Family visit",
  Status: 1,
  ApprovalComment: "Enjoy",
  TotalHours: 15,
  Creator: 1,
  Created: modified(n * 24 - 240),
  Modified: modified(n * 24 - 200),
}));

const error = (status: number, message: string): DocMockResponse => ({ status, body: { error: { code: status, message } } });

/** Whether a record matches one search clause; dates and times compare by when they are. */
function matches(rec: DeputyMockRecord, clause: Record<string, unknown>): boolean {
  const value = rec[String(clause.field)];
  const when = (v: unknown) => (typeof v === "string" ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v) : Number(v));
  const a = when(value);
  const b = when(clause.data);
  switch (clause.type) {
    case "eq":
      return a === b;
    case "ne":
      return a !== b;
    case "gt":
      return a > b;
    case "ge":
      return a >= b;
    case "lt":
      return a < b;
    default:
      return a <= b;
  }
}

export interface DeputyMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Each query: the object and the body sent. */
  readonly reads: { object: string; body: Record<string, unknown> }[];
}

export function deputyDocMock(data: DeputyMockData): DeputyMock {
  const base = data.baseUrl ?? "https://example.na.deputy.com";
  const reads: { object: string; body: Record<string, unknown> }[] = [];
  let limits = data.rateLimits ?? 0;
  const api = checkDocMock({
    integration: "deputy",
    baseUrl: base,
    auth: "bearer",
    source: { url: DOCS.resourceApi, title: "Deputy Resource API", retrievedOn: "2026-11-11", version: "API v1" },
    assumptions: [
      "A search clause's data compares a Date field with a day (YYYY-MM-DD) and a Modified field with an ISO time with an offset",
      "ge matches at or after the value given",
      "sort {Id: asc} with start and max pages through a stable order",
      "A search on Leave can match DateEnd",
      "A token Deputy doesn't take is answered 401",
    ],
    routes: [
      {
        method: "POST",
        path: "/api/v1/resource/{object}/QUERY",
        documentedAt: DOCS.searchRoster,
        respond(request) {
          if (request.headers.get("authorization") !== `Bearer ${data.token}`) return error(401, "Unauthorized");
          if (limits > 0) {
            limits--;
            return { status: 429, body: { error: { code: 429, message: "Too many requests" } }, headers: { "retry-after": "1" } };
          }
          const object = /^\/api\/v1\/resource\/([A-Za-z]+)\/QUERY$/.exec(request.url.pathname)?.[1] ?? "";
          if (!OBJECTS.has(object)) return error(404, "No such resource");
          let body: Record<string, unknown>;
          try {
            body = request.body === "" ? {} : (JSON.parse(request.body) as Record<string, unknown>);
          } catch {
            return error(400, "Body is not JSON");
          }
          reads.push({ object, body });
          const start = body.start === undefined ? 0 : Number(body.start);
          const max = body.max === undefined ? 100 : Number(body.max);
          if (!Number.isInteger(start) || start < 0) return error(400, "start must be 0 or more");
          if (!Number.isInteger(max) || max < 1) return error(400, "max must be 1 or more");
          const clauses = Object.values((body.search ?? {}) as Record<string, Record<string, unknown>>);
          for (const c of clauses) if (!TYPES.has(String(c.type)) || typeof c.field !== "string") return error(400, "Bad search");
          const sort = Object.entries((body.sort ?? { Id: "asc" }) as Record<string, string>)[0]!;
          const rows = (data.records[object] ?? [])
            .filter((rec) => clauses.every((c) => matches(rec, c)))
            .sort((x, y) => (Number(x[sort[0]]) - Number(y[sort[0]])) * (sort[1] === "desc" ? -1 : 1));
          return { status: 200, body: rows.slice(start, start + Math.min(max, 500)) };
        },
      },
    ],
  });
  return {
    api,
    fetch: docMockFetch(api),
    get reads() {
      return reads;
    },
  };
}

export default {
  integration: "deputy",
  covers: "Deputy's Resource API search for locations, areas, team members, shifts, timesheets and leave (API v1)",
  watchPages: [DOCS.resourceApi, DOCS.searchRoster],
  docMocks: () => [deputyDocMock({ token: "", records: {} }).api],
} satisfies DocMockModule;
