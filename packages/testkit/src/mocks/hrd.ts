import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * HRD Antwerp's public MyHRD API, built from HRD's API guide (a PDF on
 * my.hrdantwerp.com): the report data and report validity endpoints, the
 * only two there are. Data is synthetic; report numbers follow the guide's
 * own examples (220000000003, J210000000005), which name no real stone.
 *
 * Docs facts the mock relies on:
 * - Both endpoints sit under https://my.hrdantwerp.com/api/public and take
 *   the token in an API-Token header.
 * - GET /GetReport/{reportNumber} answers a <Report> with ReportNumber,
 *   AvailableReports (one element per report type, with ReportType,
 *   DateOfIssue and UrlPDF), Results (Shape, Carat, ColourGrade,
 *   ClarityGrade, Cut with Proportions, Polish and Symmetry, each a Code,
 *   Description and Index), AdditionalInformation (Fluorescence,
 *   Measurements, Girdle, Culet), TotalDepth, TableWidth, CrownHeight,
 *   PavilionDepth, Lab, Origin, Remarks and Inscriptions. A jewel report
 *   has Description, Remarks, WeightDiamonds, JewelType, PreciousMetal and
 *   AmountDiamonds (each a Value), Details of items, JewelReportTypes and
 *   IssueDate.
 * - POST /GetReportValidities takes a JSON array of up to 1000 report
 *   numbers with Content-Type application/json and answers <ValidReports>,
 *   one element per valid report with ReportNumber, ValidFrom and
 *   ValidUntil; numbers that aren't valid are left out. It answers only
 *   from 19:00 to 04:00 UTC, and 401 otherwise.
 * - A missing or wrong token, or a body not in the format, is 400; too
 *   many requests is 429.
 */
const GUIDE = "https://my.hrdantwerp.com/files/Public%20MyHRD%20API%20(former%20MyHRD%20webservice).pdf";
const BASE = "https://my.hrdantwerp.com/api/public";

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const el = (name: string, inner: string) => `<${name}>${inner}</${name}>`;

export interface HrdDiamondFields {
  reportNumber: string;
  reportType?: string;
  dateOfIssue?: string;
  shape?: string;
  carat?: string;
  colour?: string;
  clarity?: string;
  cut?: string;
  origin?: string;
  inscriptions?: string;
}

/** A diamond report as the report data endpoint writes it, with the guide's own field names. */
export function hrdDiamondReportXml(f: HrdDiamondFields): string {
  /** A grade as a Code, a Description and an Index, the first two under a prefix where the guide gives one. */
  const graded = (name: string, prefix: string, code: string, description: string) => el(name, el(`${prefix}Code`, esc(code)) + el(`${prefix}Description`, esc(description)) + el("Index", "1"));
  return `<?xml version="1.0" encoding="utf-8"?>
<Report xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Info>Synthetic test report.</Info>
  ${el("ReportNumber", f.reportNumber)}
  <AvailableReports><DGR>${el("ReportType", esc(f.reportType ?? "Natural Diamond Grading Report"))}${el("DateOfIssue", f.dateOfIssue ?? "2025-03-13")}${el("UrlPDF", `https://my.hrdantwerp.com/report/download/${f.reportNumber}`)}</DGR></AvailableReports>
  <Results>
    <Shape><ShapeCode>${esc(f.shape ?? "brilliant")}</ShapeCode><ShapeIndex>1</ShapeIndex></Shape>
    ${el("Carat", f.carat ?? "1.01")}
    ${graded("ColourGrade", "Colour", f.colour ?? "G", f.colour ?? "G")}
    ${graded("ClarityGrade", "Clarity", f.clarity ?? "VS1", f.clarity ?? "VS1")}
    <Cut>${graded("Proportions", "", "EXC", f.cut ?? "excellent")}${graded("Polish", "", "EXC", "excellent")}${graded("Symmetry", "", "VG", "very good")}</Cut>
  </Results>
  <AdditionalInformation>
    <Fluorescence><FluorescenceCode>nil</FluorescenceCode><FluorescenceDescription>nil</FluorescenceDescription><Index>0</Index></Fluorescence>
    <Measurements>6.42 - 6.45 mm x 3.98 mm</Measurements>
    <Girdle><GirdleEval>medium</GirdleEval><GirdleNature>FD</GirdleNature><GirdleAvg>3.5</GirdleAvg><GirdleDescription>medium, faceted</GirdleDescription></Girdle>
    <Culet><CuletEval>ptd</CuletEval><CuletCode>ptd</CuletCode><CuletPercent>0.0</CuletPercent><CuletDescription>pointed</CuletDescription></Culet>
  </AdditionalInformation>
  <TotalDepth><TotalDepthPercent>61.4</TotalDepthPercent><TotalDepthDescription>medium</TotalDepthDescription></TotalDepth>
  <TableWidth><TableWidthPercent>58</TableWidthPercent><TableWidthDescription>medium</TableWidthDescription></TableWidth>
  <CrownHeight><CrownHeightPercent>15.0</CrownHeightPercent><CrownAngle>35.6</CrownAngle><CrownHeightDescription>medium</CrownHeightDescription></CrownHeight>
  <PavilionDepth><PavilionDepthPercent>43.0</PavilionDepthPercent><PavilionAngle>40.6</PavilionAngle><PavilionDepthDescription>medium</PavilionDepthDescription></PavilionDepth>
  <HeartsAndArrows />
  <Lab>HRD - Antwerp, Belgium</Lab>
  ${el("Origin", esc(f.origin ?? "Natural"))}
  <Remarks />
  ${f.inscriptions ? el("Inscriptions", esc(f.inscriptions)) : "<Inscriptions />"}
</Report>`;
}

/** A jewel report as the report data endpoint writes it. */
export function hrdJewelReportXml(reportNumber: string, issueDate = "2025-03-13"): string {
  const value = (name: string, v: string) => el(name, el("Value", esc(v)));
  return `<?xml version="1.0" encoding="utf-8"?>
<Report>
  ${el("ReportNumber", reportNumber)}
  ${value("Description", "A synthetic ring with one diamond.")}
  ${value("AdditionalInfo", "")}
  ${value("Remarks", "Synthetic test report.")}
  ${value("WeightDiamonds", "1.00 ct")}
  ${value("JewelType", "ring")}
  ${value("PreciousMetal", "18K white gold")}
  ${value("AmountDiamonds", "1")}
  <Details><item0><Quantity>1</Quantity><Shape>brilliant</Shape><ColourGrade>G</ColourGrade><ClarityGrade>VS1</ClarityGrade><Setting>claw</Setting><CaratData><Minimum>1.00</Minimum><Maximum>1.00</Maximum><Total>1.00</Total></CaratData></item0></Details>
  <JewelReportTypes><JCRT><Title>Jewellery Report</Title><Pdf>1</Pdf><PdfUrl>https://my.hrdantwerp.com/report/download/${reportNumber}</PdfUrl></JCRT></JewelReportTypes>
  ${el("IssueDate", issueDate)}
  <Lab>HRDAntwerp</Lab>
</Report>`;
}

export interface HrdMockData {
  apiToken: string;
  /** Report XML by report number. */
  reports: Record<string, string>;
  /** What the validity check answers for each valid number. Numbers left out aren't valid. */
  validities?: Record<string, { validFrom: string; validUntil: string }>;
  /** The time the validity check's hours are judged by. Inside them when absent. */
  now?: () => Date;
  /** The next this many requests answer 429. */
  throttle?: number;
}

export interface HrdMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Every request answered, in order: report:<number> or validities:<count>. */
  readonly operations: string[];
}

const xml = (status: number, text: string): DocMockResponse => ({ status, text, headers: { "content-type": "application/xml; charset=utf-8" } });

export function hrdDocMock(data: HrdMockData): HrdMock {
  const operations: string[] = [];
  let throttle = data.throttle ?? 0;
  const gate = (token: string | null): DocMockResponse | null => {
    if (throttle > 0) {
      throttle--;
      return { status: 429, body: { message: "Too many requests" } };
    }
    return token === data.apiToken ? null : { status: 400, body: { message: "Missing or invalid API-Token header" } };
  };

  const api = checkDocMock({
    integration: "hrd",
    baseUrl: BASE,
    source: { url: GUIDE, title: "Public MyHRD API (former MyHRD webservice)", retrievedOn: "2026-11-10", version: "undated guide, with the Star/Melee report" },
    assumptions: [
      "A report number HRD has no report for answers 404",
      "The validity check's answer has one child element per valid report, whatever its name",
      "ValidFrom and ValidUntil are YYYY-MM-DD dates",
      "Origin reads Natural, or names laboratory-grown for a lab-grown diamond",
    ],
    routes: [
      {
        method: "GET",
        path: "/GetReport/{reportNumber}",
        documentedAt: GUIDE,
        respond(request, params) {
          const refused = gate(request.headers.get("api-token"));
          if (refused) return refused;
          const number = params.reportNumber!;
          operations.push(`report:${number}`);
          const report = data.reports[number];
          return report === undefined ? { status: 404, body: { message: "Report not found" } } : xml(200, report);
        },
      },
      {
        method: "POST",
        path: "/GetReportValidities",
        documentedAt: GUIDE,
        respond(request) {
          const refused = gate(request.headers.get("api-token"));
          if (refused) return refused;
          const hour = (data.now?.() ?? new Date("2026-11-10T20:00:00Z")).getUTCHours();
          if (hour >= 4 && hour < 19) return { status: 401, body: { message: "Only available between 19:00 and 04:00 UTC" } };
          if (!/^application\/json/.test(request.headers.get("content-type") ?? "")) return { status: 400, body: { message: "Body must be JSON" } };
          let numbers: unknown;
          try {
            numbers = JSON.parse(request.body);
          } catch {
            numbers = null;
          }
          if (!Array.isArray(numbers) || numbers.length > 1000 || !numbers.every((n) => typeof n === "string")) return { status: 400, body: { message: "Body must be an array of up to 1000 report numbers" } };
          operations.push(`validities:${numbers.length}`);
          const rows = (numbers as string[]).flatMap((n) => {
            const v = data.validities?.[n];
            return v ? [el(`Report_${n}`, el("ReportNumber", n) + el("ValidFrom", v.validFrom) + el("ValidUntil", v.validUntil))] : [];
          });
          return xml(200, `<?xml version="1.0" encoding="utf-8"?><ValidReports>${rows.join("")}</ValidReports>`);
        },
      },
    ],
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
  integration: "hrd",
  covers: "HRD Antwerp's public MyHRD API: report data and report validity",
  watchPages: [GUIDE],
  docMocks: () => [hrdDocMock({ apiToken: "", reports: {} }).api],
} satisfies DocMockModule;
