import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, hrdDiamondReportXml, hrdDocMock, hrdJewelReportXml, testPipeline, type HrdMock, type HrdMockData } from "@karatos/connector-testkit";
import {
  HRD_API_URL,
  HRD_REPORT_NUMBER,
  HRD_SPACING_MS,
  HRD_VALIDITY_BATCH,
  HRD_WRITES,
  HrdApiError,
  HrdConfigError,
  hrdCarats,
  hrdClient,
  hrdConnector,
  hrdDate,
  hrdReportEvent,
  hrdReportNumbersFromFile,
  hrdUnavailableEvent,
  hrdValidityNight,
  parseHrdCursor,
  type HrdClient,
  type HrdCursor,
  type HrdEvent,
  type HrdOptions,
} from "../src/index.js";
import { at, parseXml, textAt, XML_MAX_LENGTH, XmlError } from "../src/hrd/xml.js";

// Inside HRD's validity hours (19:00 to 04:00 UTC).
const NIGHT = new Date("2026-11-10T20:00:00Z");
const NOW = () => NIGHT;
const RECEIVED = NIGHT.toISOString();
const DAYTIME = () => new Date("2026-11-10T12:00:00Z");
// Shaped like an HRD token, assembled so no scanner mistakes it for a real one.
const TOKEN = ["test", "hrd", "0".repeat(24)].join("-");
const noSleep = async () => {};

const NATURAL = "220000000003";
const LAB = "220000000004";
const MELEE = "220000000006";
const JEWEL = "J210000000005";
const MISSING = "220000000009";
const LIST = [NATURAL, LAB, JEWEL, MISSING];

const VALID = { validFrom: "2025-03-13", validUntil: "2035-03-13" };
const data = (extra: Partial<HrdMockData> = {}): HrdMockData => ({
  apiToken: TOKEN,
  reports: {
    [NATURAL]: hrdDiamondReportXml({ reportNumber: NATURAL, inscriptions: "HRD 220000000003" }),
    [LAB]: hrdDiamondReportXml({ reportNumber: LAB, reportType: "Lab-Grown Diamond Grading Report", origin: "Laboratory-grown", carat: "1.50", colour: "E", clarity: "VVS2" }),
    [JEWEL]: hrdJewelReportXml(JEWEL),
  },
  validities: { [NATURAL]: VALID, [LAB]: VALID, [JEWEL]: VALID },
  now: NOW,
  ...extra,
});

function connector(mock: HrdMock = hrdDocMock(data()), extra: Partial<HrdOptions> = {}) {
  return hrdConnector({ apiToken: TOKEN, fetch: mock.fetch, sleep: noSleep, reportNumbers: async () => LIST, batchSize: 2, now: NOW, ...extra });
}

async function collect(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

const eventsOf = async (c = connector(), cursor: string | null = null) => (await collect(c.historicalImport({ organizationId: TEST_ORG, cursor }))).flatMap((b) => b.events as HrdEvent[]);
const lastCursor = (batches: SourceBatch[]) => batches[batches.length - 1]!.cursor;
const cursorOf = (c: Partial<HrdCursor>) => JSON.stringify({ looked: [], found: {}, refetch: [], checked: null, ...c } satisfies HrdCursor);

describe("HRD XML reader", () => {
  it("reads elements, text, entities, CDATA and comments, and reads past attributes", () => {
    const doc = parseXml(
      `\uFEFF<?xml version="1.0" encoding="utf-8"?>\n<!-- before --><Report a="1 > 0" b='x/y' xmlns:i="urn:x"><Name>A &amp; B &lt;C&gt; &quot;D&quot; &apos;E&apos; &#65;&#x42;</Name><!-- inside --><Empty/><Spaced  /><Data><![CDATA[1 < 2 & x]]></Data><i:nil>z</i:nil></Report><!-- after -->\n`,
    );
    expect(doc.name).toBe("Report");
    expect(doc.children.map((c) => c.name)).toEqual(["Name", "Empty", "Spaced", "Data", "i:nil"]);
    expect(textAt(doc, "Name")).toBe(`A & B <C> "D" 'E' AB`);
    expect(textAt(doc, "Data")).toBe("1 < 2 & x");
    expect(textAt(doc, "i:nil")).toBe("z");
    expect(textAt(doc, "Empty")).toBeUndefined();
    expect(at(doc, "Empty")).toEqual({ name: "Empty", children: [], text: "" });
    expect(parseXml("<a>  x  </a >")).toEqual({ name: "a", children: [], text: "x" });
    expect(parseXml("<a.b-c>1</a.b-c>").text).toBe("1");
  });

  it("finds children without case and tries each spelling given", () => {
    const doc = parseXml("<Report><Results><Item0><Carat>1</Carat></Item0></Results><Details><item1>2</item1></Details></Report>");
    expect(textAt(doc, "results", "ITEM0", "carat")).toBe("1");
    expect(textAt(doc, "Result|Results", "item0", "Carat")).toBe("1");
    expect(textAt(doc, "Detail|Details", "Item1")).toBe("2");
    expect(at(doc, "Nope", "Carat")).toBeUndefined();
    expect(at(undefined, "Carat")).toBeUndefined();
    expect(textAt(doc, "Nope")).toBeUndefined();
  });

  it("refuses declarations, entities of its own and anything malformed", () => {
    const bad: [string, RegExp][] = [
      ['<!DOCTYPE r [<!ENTITY x "y">]><r>&x;</r>', /document type declaration/],
      ["<?pi x?><r/>", /processing instruction/],
      ["<r><!ENTITY x></r>", /declaration or processing instruction inside/],
      ["<r><?pi?></r>", /declaration or processing instruction inside/],
      ["<r>&x;</r>", /entity XML doesn't define/],
      ["<r>&toString;</r>", /entity XML doesn't define/],
      ["<r>&abcdefghij;</r>", /entity XML doesn't define/],
      ["<r>&#65x;</r>", /entity XML doesn't define/],
      ["<r>&a b;</r>", /an & that starts no entity/],
      ["<r><!-x--></r>", /declaration or processing instruction inside/],
      ["<!-x--><r/>", /document type declaration/],
      ["<!--><r/>", /comment that doesn't end/],
      ['<r x a="1"/>', /malformed attribute/],
      ["<a.b></aXb>", /ends with another element's name/],
      ["<r>a & b</r>", /an & that starts no entity/],
      ["<r>&amp</r>", /an & that starts no entity/],
      ["<r>&#xD800;</r>", /out of range/],
      ["<r>&#xDFFF;</r>", /out of range/],
      ["<r>&#1114112;</r>", /out of range/],
      ["<r><a></b></r>", /ends with another element's name/],
      ["<r><ab></a></ab></r>", /ends with another element's name/],
      ["<r><a></a.b></r>", /ends with another element's name/],
      ["<r>", /doesn't end/],
      ["<r/><s/>", /content after the root/],
      ["<r/>x", /content after the root/],
      ["x<r/>", /expected an element/],
      ["< r/>", /without a name/],
      ["<r a=1/>", /malformed attribute/],
      ['<r a="<"/>', /malformed attribute/],
      ["<r><!-- x </r>", /comment that doesn't end/],
      ["<!-- x", /comment that doesn't end/],
      ["<r><![CDATA[x</r>", /CDATA section that doesn't end/],
      ["<?xml version='1.0'", /declaration that doesn't end/],
      ["", /expected an element/],
    ];
    for (const [source, message] of bad) expect(() => parseXml(source), source).toThrow(message);
    expect(() => parseXml("<r>x</r>")).not.toThrow();
    expect(parseXml("<r>&#x10FFFF;&#xD7FF;&#xE000;</r>").text).toBe("\u{10FFFF}퟿");
    expect(() => parseXml(`<r>${" ".repeat(XML_MAX_LENGTH - 6)}</r>`)).toThrow(/too large/);
    expect(parseXml(`<r>${" ".repeat(XML_MAX_LENGTH - 7)}</r>`).name).toBe("r");
    expect(XML_MAX_LENGTH).toBe(2_000_000);
    expect(parseXml("<?xml\tversion='1.0'?><r/>").name).toBe("r");
    expect(() => parseXml(`${"<a>".repeat(34)}${"</a>".repeat(34)}`)).toThrow(/nested too deep/);
    expect(parseXml(`${"<a>".repeat(33)}x${"</a>".repeat(33)}`).name).toBe("a");
    expect(new XmlError("x").name).toBe("XmlError");
  });
});

describe("HRD client", () => {
  it("sends only its two reads, to HRD's host, with the token in API-Token, spaced a quarter second apart", async () => {
    const mock = hrdDocMock(data());
    const waits: number[] = [];
    const client = hrdClient({ apiToken: ` ${TOKEN} `, fetch: mock.fetch, sleep: async (ms) => void waits.push(ms) });
    expect((await client.report(NATURAL)).kind).toBe("found");
    expect(await client.validities([NATURAL])).toEqual(new Map([[NATURAL, VALID]]));
    expect(mock.fetch.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${HRD_API_URL}/GetReport/${NATURAL}`, `POST ${HRD_API_URL}/GetReportValidities`]);
    expect(waits).toEqual([HRD_SPACING_MS]);
    expect(HRD_API_URL).toBe("https://my.hrdantwerp.com/api/public");
    expect(HRD_SPACING_MS).toBe(250);

    const seen: { headers: Headers; body: unknown; method: string | undefined }[] = [];
    const spy = hrdClient({
      apiToken: TOKEN,
      sleep: noSleep,
      fetch: async (_url, init) => {
        seen.push({ headers: new Headers(init?.headers), body: init?.body, method: init?.method });
        return new Response("<ValidReports/>", { status: 200 });
      },
    });
    await spy.report(NATURAL).catch(() => undefined);
    await spy.validities([NATURAL]);
    expect(seen.map((s) => [s.method, s.headers.get("api-token"), s.headers.get("accept"), s.headers.get("content-type"), s.body])).toEqual([
      ["GET", TOKEN, "application/xml", null, undefined],
      ["POST", TOKEN, "application/xml", "application/json", JSON.stringify([NATURAL])],
    ]);
  });

  it("reads a report, and takes a 404 or an answer for another number as none", async () => {
    const mock = hrdDocMock(data({ reports: { ...data().reports, [MELEE]: hrdDiamondReportXml({ reportNumber: "220000000007" }), "220000000008": "<Report><Info>x</Info></Report>" } }));
    const client = hrdClient({ apiToken: TOKEN, fetch: mock.fetch, sleep: noSleep });
    const found = await client.report(NATURAL);
    expect(found.kind === "found" && textAt(found.report, "ReportNumber")).toBe(NATURAL);
    expect(await client.report(MISSING)).toEqual({ kind: "not_found" });
    expect(await client.report(MELEE)).toEqual({ kind: "not_found" });
    expect(await client.report("220000000008")).toEqual({ kind: "not_found" });
    const lower = hrdDocMock(data({ reports: { [JEWEL]: hrdJewelReportXml(JEWEL.toLowerCase()) } }));
    expect((await hrdClient({ apiToken: TOKEN, fetch: lower.fetch, sleep: noSleep }).report(JEWEL)).kind).toBe("found");
  });

  it("checks every value before sending it, and the token's shape before anything", async () => {
    const mock = hrdDocMock(data());
    const client = hrdClient({ apiToken: TOKEN, fetch: mock.fetch, sleep: noSleep });
    for (const bad of ["../x", "22000000000a", "12345", "ABC123456", `22${"0".repeat(13)}`, " 220000000003", "j210000000005"]) {
      await expect(client.report(bad), bad).rejects.toThrow(HrdConfigError);
    }
    await expect(client.report("x".repeat(40))).rejects.toThrow(`not an HRD report number: "${"x".repeat(20)}"`);
    for (const bad of [[], Array.from({ length: HRD_VALIDITY_BATCH + 1 }, () => NATURAL), [NATURAL, "../x"]]) {
      await expect(client.validities(bad)).rejects.toThrow(`a validity check takes 1 to ${HRD_VALIDITY_BATCH} HRD report numbers`);
    }
    expect(mock.fetch.calls).toHaveLength(0);
    expect(await client.validities(Array.from({ length: HRD_VALIDITY_BATCH }, () => NATURAL))).toEqual(new Map([[NATURAL, VALID]]));
    for (const bad of ["", "short", "a".repeat(15), `${"a".repeat(20)} b`, "a".repeat(513), `${"a".repeat(20)}"`]) {
      expect(() => hrdClient({ apiToken: bad }), JSON.stringify(bad)).toThrow("HRD_API_TOKEN is missing or not in the expected shape");
    }
    expect(() => hrdClient({ apiToken: undefined as unknown as string })).toThrow(HrdConfigError);
    expect(() => hrdClient({ apiToken: "a".repeat(16) })).not.toThrow();
    expect(() => hrdClient({ apiToken: "a".repeat(512) })).not.toThrow();
    expect(() => hrdClient({ apiToken: "aA0._~+/=-".repeat(2) })).not.toThrow();
    expect(HRD_REPORT_NUMBER.test("AB12345678901234")).toBe(true);
    expect(HRD_REPORT_NUMBER.test("123456")).toBe(true);
  });

  it("answers a token HRD turns down with an error that never shows it", async () => {
    for (const status of [400, 403]) {
      const client = hrdClient({ apiToken: TOKEN, sleep: noSleep, fetch: async () => new Response(`bad token ${TOKEN}`, { status }) });
      const error = await client.report(NATURAL).catch((e: unknown) => e as Error);
      expect(error).toBeInstanceOf(HrdConfigError);
      expect(error.message).toBe(`HRD turned down HRD_API_TOKEN (HTTP ${status})`);
      expect(error.message).not.toContain(TOKEN);
    }
    const wrong = hrdDocMock(data({ apiToken: "x".repeat(20) }));
    await expect(hrdClient({ apiToken: TOKEN, fetch: wrong.fetch, sleep: noSleep }).validities([NATURAL])).rejects.toThrow(HrdConfigError);
    expect(new HrdConfigError("x").name).toBe("HrdConfigError");
  });

  it("waits out a 429 or a 5xx as Retry-After says, capped, then gives up", async () => {
    const waits: number[] = [];
    const throttled = hrdDocMock(data({ throttle: 2 }));
    const client = hrdClient({ apiToken: TOKEN, fetch: throttled.fetch, sleep: async (ms) => void waits.push(ms) });
    expect((await client.report(NATURAL)).kind).toBe("found");
    // Two backoffs (1s, 2s) with a spacing wait before each request after the first.
    expect(waits).toEqual([1000, HRD_SPACING_MS, 2000, HRD_SPACING_MS]);

    for (const [status, after, wait] of [[429, "5", 5000], [503, "999", 60_000], [502, "soon", 1000], [500, "0", 1000], [504, "-3", 1000]] as const) {
      const w: number[] = [];
      let calls = 0;
      const c = hrdClient({ apiToken: TOKEN, retries: 2, sleep: async (ms) => void w.push(ms), fetch: async () => (calls++, new Response("", { status, headers: { "retry-after": after } })) });
      const error = await c.report(NATURAL).catch((e: unknown) => e as HrdApiError);
      expect(error).toBeInstanceOf(HrdApiError);
      expect(error.status).toBe(status);
      expect(calls).toBe(3);
      expect(w.filter((ms) => ms !== HRD_SPACING_MS)[0]).toBe(wait);
      expect(error.message).toBe(status === 429 ? "HRD's request limit was reached during a report lookup; the rest waits for the next sync" : `HRD answered HTTP ${status} for a report lookup`);
    }
    const once: number[] = [];
    let calls = 0;
    const flaky = hrdClient({ apiToken: TOKEN, sleep: async (ms) => void once.push(ms), fetch: async () => (calls++ === 0 ? new Response("", { status: 502 }) : new Response("<ValidReports/>", { status: 200 })) });
    expect(await flaky.validities([NATURAL])).toEqual(new Map());
    expect(once).toEqual([1000, HRD_SPACING_MS]);
    let fourOhFours = 0;
    const notRetried = hrdClient({ apiToken: TOKEN, sleep: noSleep, fetch: async () => (fourOhFours++, new Response("", { status: 404 })) });
    expect(await notRetried.report(NATURAL)).toEqual({ kind: "not_found" });
    expect(fourOhFours).toBe(1);
    let tries = 0;
    const defaults = hrdClient({ apiToken: TOKEN, fetch: async () => (tries++, new Response("", { status: 429 })), sleep: noSleep });
    await expect(defaults.validities([NATURAL])).rejects.toThrow("HRD's request limit was reached during the validity check; the rest waits for the next sync");
    expect(tries).toBe(4);
  });

  it("errors on other answers without repeating what HRD sent", async () => {
    const answer = (status: number, text: string) => hrdClient({ apiToken: TOKEN, sleep: noSleep, retries: 0, fetch: async () => new Response(text, { status }) });
    await expect(answer(302, "").report(NATURAL)).rejects.toThrow("HRD answered HTTP 302 for a report lookup");
    await expect(answer(200, "<Error>secret</Error>").report(NATURAL)).rejects.toThrow("HRD answered a report lookup without a report");
    await expect(answer(200, "<!DOCTYPE x><Report/>").report(NATURAL)).rejects.toThrow("HRD answered a report lookup with XML that doesn't read");
    await expect(answer(200, "not xml secret").validities([NATURAL])).rejects.toThrow("HRD answered the validity check with XML that doesn't read");
    await expect(answer(500, "").validities([NATURAL])).rejects.toThrow("HRD answered HTTP 500 for the validity check");
    await expect(answer(404, "").validities([NATURAL])).rejects.toThrow("HRD answered HTTP 404 for the validity check");
    await expect(answer(200, "<Report/>").validities([NATURAL])).rejects.toThrow("HRD answered the validity check without its list");
    expect(await answer(200, "<report><reportnumber>220000000003</reportnumber></report>").report(NATURAL)).toMatchObject({ kind: "found" });
    expect(await answer(200, "<validreports/>").validities([NATURAL])).toEqual(new Map());
    const error = await answer(200, "<x>secret</x>").report(NATURAL).catch((e: unknown) => e as HrdApiError);
    expect([error.status, error.name, error.message.includes("secret")]).toEqual([200, "HrdApiError", false]);
    const thrown = hrdClient({ apiToken: TOKEN, sleep: noSleep, fetch: async () => ({ status: 200, headers: new Headers(), text: async () => Promise.reject(new TypeError("stream broke")) }) as unknown as Response });
    await expect(thrown.report(NATURAL)).rejects.toThrow(TypeError);
  });

  it("reads the validity check: only numbers it asked about, with dates that read, and null outside HRD's hours", async () => {
    const day = hrdDocMock(data({ now: DAYTIME }));
    expect(await hrdClient({ apiToken: TOKEN, fetch: day.fetch, sleep: noSleep }).validities([NATURAL])).toBeNull();
    const answer = (text: string) => hrdClient({ apiToken: TOKEN, sleep: noSleep, fetch: async () => new Response(text, { status: 200 }) });
    const rows = [
      "<Report_1><ReportNumber>220000000003</ReportNumber><ValidFrom>2025-03-13T00:00:00</ValidFrom><ValidUntil>2035-03-13T00:00:00</ValidUntil></Report_1>",
      "<Report_2><ReportNumber>j210000000005</ReportNumber><ValidFrom>2021-05-27</ValidFrom><ValidUntil>never</ValidUntil></Report_2>",
      "<Report_3><ReportNumber>220000000004</ReportNumber><ValidFrom>x2025-01-01</ValidFrom></Report_3>",
      "<Report_4><ReportNumber>220000000099</ReportNumber><ValidFrom>2025-01-01</ValidFrom></Report_4>",
      "<Report_5><ValidFrom>2025-01-01</ValidFrom></Report_5>",
      "<Report_6><ReportNumber>220000000006</ReportNumber></Report_6>",
      "<Report_7><ReportNumber>220000000007</ReportNumber><ValidFrom>2025-01-01</ValidFrom><ValidUntil>x2035-01-01</ValidUntil></Report_7>",
    ];
    expect(await answer(`<ValidReports>${rows.join("")}</ValidReports>`).validities([NATURAL, JEWEL, LAB, MELEE, "220000000007"])).toEqual(
      new Map([
        [NATURAL, { validFrom: "2025-03-13", validUntil: "2035-03-13" }],
        [JEWEL, { validFrom: "2021-05-27", validUntil: null }],
        ["220000000007", { validFrom: "2025-01-01", validUntil: null }],
      ]),
    );
  });
});

describe("HRD values", () => {
  it("reads carat weights and issue dates, returning null rather than guessing", () => {
    expect(["1.00 ct", "0.5", "2 cts", "1.5carats", "3 carat", "1.0001", "1.00 CT"].map(hrdCarats)).toEqual([1, 0.5, 2, 1.5, 3, 1.0001, 1]);
    expect(["", undefined, "about 1", "1.00 ct.", "12345", "1.00001", "x1.00", "1.00 ctx", ".5"].map(hrdCarats)).toEqual([null, null, null, null, null, null, null, null, null]);
    expect(hrdDate("2025-03-13")).toBe("2025-03-13T00:00:00.000Z");
    expect(hrdDate("2025-03-13T10:00:00")).toBe("2025-03-13T00:00:00.000Z");
    expect([undefined, "", "2025-02-30", "13/03/2025", "x2025-03-13", "2025-3-13"].map(hrdDate)).toEqual([null, null, null, null, null, null]);
  });

  it("night by night, only in the hours HRD answers the validity check", () => {
    expect(hrdValidityNight(new Date("2026-11-10T19:00:00Z"))).toBe("2026-11-10");
    expect(hrdValidityNight(new Date("2026-11-10T23:59:59Z"))).toBe("2026-11-10");
    expect(hrdValidityNight(new Date("2026-11-11T00:00:00Z"))).toBe("2026-11-10");
    expect(hrdValidityNight(new Date("2026-11-11T03:59:59Z"))).toBe("2026-11-10");
    expect(hrdValidityNight(new Date("2026-11-11T04:00:00Z"))).toBeNull();
    expect(hrdValidityNight(new Date("2026-11-11T18:59:59Z"))).toBeNull();
    expect(hrdValidityNight(new Date("2026-03-01T01:00:00Z"))).toBe("2026-02-28");
  });

  it("reads a report number list, skipping blanks and comments, and names bad lines without their contents", async () => {
    const read = hrdReportNumbersFromFile("/list.csv", async (p) => (p === "/list.csv" ? `${NATURAL},ring\n\n# note\nj210000000005\n${NATURAL}\n` : ""));
    expect(await read()).toEqual([NATURAL, JEWEL]);
    await expect(hrdReportNumbersFromFile("/x", async () => "secret-line\n")()).rejects.toThrow("report number list: line 1 is not a report number");
  });
});

describe("HRD connector", () => {
  it("uses only synthetic data in its fixtures", () => {
    assertSynthetic(data());
  });

  it("survives every runSync scenario", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(), expected: { ingested: 4 } });
    // Four numbers in batches of two, then one validity check.
    expect(result.full.batches).toBe(3);
    expect(result.replay.duplicates).toBe(4);
    expect(JSON.parse(result.full.cursor!)).toEqual({ looked: [NATURAL, LAB, MISSING, JEWEL].sort(), found: { [NATURAL]: VALID.validFrom, [LAB]: VALID.validFrom, [JEWEL]: VALID.validFrom }, refetch: [], checked: "2026-11-10" });
  });

  it("records a natural diamond's grades, measurements and proportions, without its PDF link", async () => {
    const [natural] = await eventsOf();
    expect(natural).toEqual({
      id: expect.stringMatching(/^hrd_report:220000000003:[0-9a-f]{12}$/),
      type: "grading.report_retrieved",
      occurredAt: "2025-03-13T00:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^hrd:report:220000000003:[0-9a-f]{12}$/),
      payload: {
        lab: "HRD",
        reportNumber: NATURAL,
        reportType: "Natural Diamond Grading Report",
        reportTypeCode: "DGR",
        kind: "natural_diamond",
        issuedOn: "2025-03-13",
        shape: "brilliant",
        caratWeight: 1.01,
        color: "G",
        clarity: "VS1",
        cut: "excellent",
        polish: "excellent",
        symmetry: "very good",
        fluorescence: "nil",
        measurements: "6.42 - 6.45 mm x 3.98 mm",
        inscriptions: "HRD 220000000003",
        origin: "Natural",
        proportions: { depthPct: 61.4, tablePct: 58, crownHeightPct: 15, crownAngle: 35.6, pavilionDepthPct: 43, pavilionAngle: 40.6, girdle: "medium, faceted", culet: "pointed" },
      },
    });
    expect(JSON.stringify(natural)).not.toContain("https://");
  });

  it("records lab-grown diamonds, jewels and melee, and what a sparse report holds", async () => {
    const events = await eventsOf();
    expect(events.find((e) => e.payload.reportNumber === LAB)!.payload).toMatchObject({ kind: "lab_grown_diamond", reportType: "Lab-Grown Diamond Grading Report", caratWeight: 1.5, color: "E", clarity: "VVS2" });
    const jewel = events.find((e) => e.payload.reportNumber === JEWEL)!;
    expect(jewel.occurredAt).toBe("2025-03-13T00:00:00.000Z");
    expect(jewel.payload).toEqual({
      lab: "HRD",
      reportNumber: JEWEL,
      kind: "jewelry",
      issuedOn: "2025-03-13",
      jewelType: "ring",
      metal: "18K white gold",
      diamondCount: 1,
      caratWeight: 1,
      description: "A synthetic ring with one diamond.",
      comments: "Synthetic test report.",
      stones: [{ quantity: 1, shape: "brilliant", color: "G", clarity: "VS1", setting: "claw", totalCarats: 1 }],
      reportTypes: ["JCRT"],
    });
    expect(JSON.stringify(jewel)).not.toContain("https://");

    const at = (xml: string) => hrdReportEvent(parseXml(xml), RECEIVED);
    const melee = at(
      `<Report><ReportNumber>${MELEE}</ReportNumber><AvailableReports><sm><ReportType>Star/MeleeExaminationService</ReportType><DateOfIssue>2026-02-27</DateOfIssue></sm></AvailableReports><Result><Carat>9.00</Carat><Specifications><Fluorescence>Slight or better</Fluorescence><Colour>Rare White (G) or better</Colour><Clarity>Si or better</Clarity></Specifications><Sealingnumber>1234</Sealingnumber></Result><Remark>Sealed parcel</Remark></Report>`,
    );
    expect(melee.payload).toEqual({
      lab: "HRD",
      reportNumber: MELEE,
      reportType: "Star/MeleeExaminationService",
      reportTypeCode: "SM",
      kind: "melee",
      issuedOn: "2026-02-27",
      caratWeight: 9,
      comments: "Sealed parcel",
      specification: { fluorescence: "Slight or better", color: "Rare White (G) or better", clarity: "Si or better" },
    });
    // Grades with only a code, proportions under Results, and names spelled the guide's other way.
    const coded = at(
      `<Report><ReportNumber>${NATURAL}</ReportNumber><AvailableReports><DGR><DateOfIssue>2025-01-02</DateOfIssue></DGR></AvailableReports><Results><ColourGrade><ColourCode>D</ColourCode></ColourGrade><ClarityGrade><Code>IF</Code></ClarityGrade><Cut><Polish><Description>good</Description></Polish></Cut><TotalDepth><TotalDepthPercent>60</TotalDepthPercent></TotalDepth><TableWidth><TableWidthPercent>57.5</TableWidthPercent></TableWidth></Results><CrownHeight><CrownHeightAngle>34</CrownHeightAngle></CrownHeight><AdditionalInformation><Girdle><GirdleEval>thin</GirdleEval></Girdle><Culet><CuletEval>none</CuletEval></Culet><Inscriptions>HRD 1</Inscriptions><HeartsAndArrows>yes</HeartsAndArrows></AdditionalInformation><Remarks>Note</Remarks><Origin>Synthetic</Origin></Report>`,
    );
    expect(coded.payload).toEqual({
      lab: "HRD",
      reportNumber: NATURAL,
      reportTypeCode: "DGR",
      kind: "lab_grown_diamond",
      issuedOn: "2025-01-02",
      color: "D",
      clarity: "IF",
      polish: "good",
      inscriptions: "HRD 1",
      comments: "Note",
      heartsAndArrows: "yes",
      origin: "Synthetic",
      proportions: { depthPct: 60, tablePct: 57.5, crownAngle: 34, girdle: "thin", culet: "none" },
    });
    expect(coded.payload).not.toHaveProperty("caratWeight");
    const unknown = at(`<Report><ReportNumber>${NATURAL}</ReportNumber><Origin>Unknown</Origin><TotalDepth><TotalDepthPercent>sixty</TotalDepthPercent></TotalDepth><Results><Carat>1</Carat></Results><HeartsAndArrows>yes</HeartsAndArrows><Inscriptions>top</Inscriptions></Report>`);
    expect(unknown.payload).toEqual({ lab: "HRD", reportNumber: NATURAL, kind: "other", caratWeight: 1, heartsAndArrows: "yes", inscriptions: "top", origin: "Unknown" });
    expect(at(`<Report><ReportNumber>${NATURAL}</ReportNumber><Origin>Lab grown</Origin></Report>`).payload.kind).toBe("lab_grown_diamond");
    // The first report type HRD lists is the one kept; a grade's description wins over its code.
    expect(at(`<Report><ReportNumber>${NATURAL}</ReportNumber><AvailableReports><DGR><ReportType>Grading</ReportType></DGR><SM><ReportType>Melee</ReportType></SM></AvailableReports><Results><ClarityGrade><ClarityCode>lc</ClarityCode><ClarityDescription>LC</ClarityDescription></ClarityGrade></Results></Report>`).payload).toMatchObject({ reportType: "Grading", reportTypeCode: "DGR", clarity: "LC" });
    expect(at(`<Report><ReportNumber>${NATURAL}</ReportNumber><Origin>GROWN</Origin></Report>`).payload.kind).toBe("lab_grown_diamond");
    expect(at(`<Report><ReportNumber>${NATURAL}</ReportNumber><Origin>natural</Origin></Report>`).payload.kind).toBe("natural_diamond");
    expect(at(`<Report><ReportNumber>${NATURAL}</ReportNumber><AvailableReports><SM/></AvailableReports><Origin>natural</Origin></Report>`).payload.kind).toBe("melee");
    expect(at(`<Report><ReportNumber>${NATURAL}</ReportNumber><TotalDepth><TotalDepthPercent>1234</TotalDepthPercent></TotalDepth><TableWidth><TableWidthPercent>5.1234</TableWidthPercent></TableWidth></Report>`).payload.proportions).toBeUndefined();
    const sparseJewel = at(`<Report><ReportNumber>${JEWEL}</ReportNumber><JewelReportTypes><JMIN/><ajrm/></JewelReportTypes><AmountDiamonds><Value>many</Value></AmountDiamonds><Detail><Item0><Quantity>x</Quantity><Carat>0.25</Carat></Item0></Detail></Report>`);
    expect(sparseJewel.payload).toEqual({ lab: "HRD", reportNumber: JEWEL, kind: "jewelry", stones: [{ totalCarats: 0.25 }], reportTypes: ["AJRM", "JMIN"] });
    expect(at(`<Report><ReportNumber>${JEWEL}</ReportNumber><JewelType><Value>pendant</Value></JewelType></Report>`).payload).toEqual({ lab: "HRD", reportNumber: JEWEL, kind: "jewelry", jewelType: "pendant", reportTypes: [] });
    expect(at(`<Report><ReportNumber>${NATURAL}</ReportNumber></Report>`).payload).toEqual({ lab: "HRD", reportNumber: NATURAL, kind: "other" });
    // A jewel is dated by IssueDate, a diamond by its report's DateOfIssue: never the other.
    expect(at(`<Report><ReportNumber>${JEWEL}</ReportNumber><JewelType/><AvailableReports><X><DateOfIssue>2025-01-01</DateOfIssue></X></AvailableReports></Report>`).occurredAt).toBeUndefined();
    expect(at(`<Report><ReportNumber>${NATURAL}</ReportNumber><IssueDate>2025-01-01</IssueDate></Report>`).occurredAt).toBeUndefined();
  });

  it("keys a report by its number and what is kept, so a change is new and the same report is a duplicate", () => {
    const one = hrdReportEvent(parseXml(hrdDiamondReportXml({ reportNumber: NATURAL })), RECEIVED);
    const again = hrdReportEvent(parseXml(hrdDiamondReportXml({ reportNumber: NATURAL }).replace("<Info>Synthetic test report.</Info>", "<Info>Other words</Info>")), "2027-01-01T00:00:00.000Z");
    const changed = hrdReportEvent(parseXml(hrdDiamondReportXml({ reportNumber: NATURAL, clarity: "VS2" })), RECEIVED);
    expect(again.idempotencyKey).toBe(one.idempotencyKey);
    expect(changed.idempotencyKey).not.toBe(one.idempotencyKey);
    expect(one.id).toBe(one.idempotencyKey.replace(/^hrd:/, "hrd_"));
    const odd = hrdReportEvent(parseXml(`<Report><ReportNumber>a b/c</ReportNumber></Report>`), RECEIVED);
    expect(odd.id).toMatch(/^hrd_report:A_B_C:[0-9a-f]{12}$/);
    expect(odd.id.startsWith("hrd_")).toBe(true);
    expect(hrdUnavailableEvent(MISSING, "not_found", RECEIVED)).toEqual({ id: `hrd_unavailable:${MISSING}:not_found`, type: "grading.report_unavailable", occurredAt: RECEIVED, receivedAt: RECEIVED, idempotencyKey: `hrd:unavailable:${MISSING}:not_found`, payload: { lab: "HRD", reportNumber: MISSING, reason: "not_found" } });
  });

  it("dead-letters a report with no readable issue date or number, keeping it", async () => {
    const reports = { [NATURAL]: hrdDiamondReportXml({ reportNumber: NATURAL, dateOfIssue: "soon" }), [LAB]: hrdDiamondReportXml({ reportNumber: LAB }).replace(`<ReportNumber>${LAB}</ReportNumber>`, "<ReportNumber></ReportNumber>") };
    const { memory, pipeline } = testPipeline();
    // A report that names no number answers as none; one with a number and no date is kept dead-lettered.
    const report = await runSync({ connector: connector(hrdDocMock(data({ reports })), { reportNumbers: async () => [NATURAL], now: DAYTIME }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 0, deadLettered: 1 });
    expect(memory.deadLetters.map((d) => d.issues.map((i) => i.path))).toEqual([["occurredAt"]]);
    expect(hrdReportEvent(parseXml("<Report><AvailableReports><DGR><DateOfIssue>2025-01-01</DateOfIssue></DGR></AvailableReports></Report>"), RECEIVED).occurredAt).toBeUndefined();
  });

  it("records a number HRD has no report for once, and looks each number up only once as the list grows", async () => {
    const mock = hrdDocMock(data());
    let list = [NATURAL, MISSING];
    const { memory, pipeline } = testPipeline();
    const c = connector(mock, { reportNumbers: async () => list, now: DAYTIME });
    const sync = () => runSync({ connector: c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(await sync()).toMatchObject({ ingested: 2 });
    expect(memory.events.filter((e) => e.type === "grading.report_unavailable").map((e) => [e.payload.reportNumber, e.payload.reason])).toEqual([[MISSING, "not_found"]]);
    mock.operations.length = 0;
    expect(await sync()).toMatchObject({ ingested: 0 });
    expect(mock.operations).toEqual([]);
    list = [NATURAL, MISSING, JEWEL];
    expect(await sync()).toMatchObject({ ingested: 1 });
    expect(mock.operations).toEqual([`report:${JEWEL}`]);
  });

  it("stops at maxLookups, leaving the rest for the next sync", async () => {
    const mock = hrdDocMock(data());
    const c = connector(mock, { maxLookups: 3, now: DAYTIME });
    const batches = await collect(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(mock.operations).toEqual([`report:${NATURAL}`, `report:${LAB}`, `report:${JEWEL}`]);
    mock.operations.length = 0;
    await collect(c.historicalImport({ organizationId: TEST_ORG, cursor: lastCursor(batches) }));
    expect(mock.operations).toEqual([`report:${MISSING}`]);
    expect(() => connector(mock, { maxLookups: 0 })).toThrow("maxLookups must be a positive whole number");
    expect(() => connector(mock, { batchSize: 1.5 })).toThrow("batchSize must be a positive whole number");
    expect(() => connector(mock, { batchSize: 1 })).not.toThrow();
    const many = Array.from({ length: 60 }, (_, i) => String(230000000000 + i));
    const counted = hrdDocMock(data());
    const defaults = await collect(connector(counted, { reportNumbers: async () => many, batchSize: undefined, now: DAYTIME }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(counted.operations).toHaveLength(50);
    expect(defaults).toHaveLength(2);
    expect(await collect(connector(hrdDocMock(data()), { reportNumbers: async () => many, batchSize: undefined, maxLookups: 26, now: DAYTIME }).historicalImport({ organizationId: TEST_ORG, cursor: null }))).toHaveLength(2);
  });

  it("checks validity once a night, looks a reissued report up again and flags one HRD no longer lists", async () => {
    let now = new Date("2026-11-10T20:00:00Z");
    const validities: HrdMockData["validities"] = { [NATURAL]: VALID, [LAB]: VALID, [JEWEL]: VALID };
    const reports = { ...data().reports };
    const mock = hrdDocMock(data({ reports, validities, now: () => now }));
    const { memory, pipeline } = testPipeline();
    const c = connector(mock, { now: () => now });
    const sync = () => runSync({ connector: c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    await sync();
    expect(mock.operations.filter((o) => o.startsWith("validities"))).toEqual(["validities:3"]);
    // Later the same night: already checked.
    now = new Date("2026-11-11T02:00:00Z");
    mock.operations.length = 0;
    expect(await sync()).toMatchObject({ ingested: 0 });
    expect(mock.operations).toEqual([]);
    // Daytime: HRD doesn't answer, so nothing is asked.
    now = new Date("2026-11-11T12:00:00Z");
    expect(await sync()).toMatchObject({ ingested: 0 });
    expect(mock.operations).toEqual([]);
    // The next night HRD has reissued one report and dropped another.
    validities[NATURAL] = { validFrom: "2026-11-01", validUntil: "2036-11-01" };
    delete validities[LAB];
    reports[NATURAL] = hrdDiamondReportXml({ reportNumber: NATURAL, clarity: "VS2", dateOfIssue: "2026-11-01" });
    now = new Date("2026-11-11T21:00:00Z");
    expect(await sync()).toMatchObject({ ingested: 1 });
    expect(memory.events.at(-1)).toMatchObject({ type: "grading.report_unavailable", occurredAt: now.toISOString(), payload: { reportNumber: LAB, reason: "no_longer_valid" } });
    expect(mock.operations).toEqual(["validities:3"]);
    const saved = JSON.parse((await memory.getCheckpoint(TEST_ORG, "hrd", "incremental"))!) as HrdCursor;
    expect(saved).toMatchObject({ refetch: [NATURAL], checked: "2026-11-11", found: { [NATURAL]: "2026-11-01", [LAB]: VALID.validFrom, [JEWEL]: VALID.validFrom } });
    // The sync after looks the reissued report up again, before any new number.
    mock.operations.length = 0;
    now = new Date("2026-11-12T12:00:00Z");
    expect(await sync()).toMatchObject({ ingested: 1 });
    expect(mock.operations).toEqual([`report:${NATURAL}`]);
    expect(memory.events.at(-1)!.payload).toMatchObject({ reportNumber: NATURAL, clarity: "VS2", issuedOn: "2026-11-01" });
    expect(JSON.parse((await memory.getCheckpoint(TEST_ORG, "hrd", "incremental"))!)).toMatchObject({ refetch: [], found: { [NATURAL]: "2026-11-01" } });
    // The dropped report is flagged once, however many nights it stays dropped.
    now = new Date("2026-11-12T22:00:00Z");
    expect(await sync()).toMatchObject({ ingested: 0, duplicates: 1 });
  });

  it("takes the first valid-from date it sees as the baseline, not as a reissue", async () => {
    const mock = hrdDocMock(data());
    const batches = await collect(connector(mock, { reportNumbers: async () => [NATURAL] }).incrementalSync({ organizationId: TEST_ORG, cursor: cursorOf({ looked: [NATURAL], found: { [NATURAL]: "" } }) }));
    expect(JSON.parse(lastCursor(batches))).toEqual({ looked: [NATURAL], found: { [NATURAL]: VALID.validFrom }, refetch: [], checked: "2026-11-10" });
    const same = await collect(connector(mock, { reportNumbers: async () => [NATURAL] }).incrementalSync({ organizationId: TEST_ORG, cursor: cursorOf({ looked: [NATURAL], found: { [NATURAL]: VALID.validFrom } }) }));
    expect(JSON.parse(lastCursor(same))).toMatchObject({ refetch: [] });
  });

  it("leaves numbers taken off the list alone, and drops a reissued report HRD no longer has", async () => {
    const mock = hrdDocMock(data());
    const cursor = cursorOf({ looked: [NATURAL, LAB], found: { [NATURAL]: VALID.validFrom, [LAB]: "2020-01-01" }, refetch: [LAB, MISSING] });
    const batches = await collect(connector(mock, { reportNumbers: async () => [NATURAL] }).incrementalSync({ organizationId: TEST_ORG, cursor }));
    expect(mock.operations).toEqual(["validities:1"]);
    expect(JSON.parse(lastCursor(batches))).toMatchObject({ refetch: [LAB, MISSING] });
    const gone = hrdDocMock(data({ reports: {} }));
    const after = await collect(connector(gone, { reportNumbers: async () => [LAB], now: DAYTIME }).incrementalSync({ organizationId: TEST_ORG, cursor }));
    expect(gone.operations).toEqual([`report:${LAB}`]);
    expect(after.flatMap((b) => b.events as HrdEvent[]).map((e) => e.payload.reason)).toEqual(["not_found"]);
    expect(JSON.parse(lastCursor(after))).toEqual({ looked: [NATURAL, LAB], found: { [NATURAL]: VALID.validFrom }, refetch: [MISSING], checked: null });
  });

  it("looks reissued reports up before new numbers, and writes its checkpoint in a steady order", async () => {
    const mock = hrdDocMock(data({ now: DAYTIME }));
    const cursor = cursorOf({ looked: [NATURAL, LAB], found: { [NATURAL]: VALID.validFrom, [LAB]: VALID.validFrom }, refetch: [NATURAL, LAB] });
    await collect(connector(mock, { reportNumbers: async () => [JEWEL, MISSING, LAB, NATURAL], maxLookups: 3, now: DAYTIME }).incrementalSync({ organizationId: TEST_ORG, cursor }));
    expect(mock.operations).toEqual([`report:${NATURAL}`, `report:${LAB}`, `report:${JEWEL}`]);
    const unsorted = cursorOf({ looked: [LAB, NATURAL], found: { [LAB]: "2020-01-01", [NATURAL]: "2020-01-01" }, refetch: [MISSING, MELEE] });
    const night = await collect(connector(hrdDocMock(data()), { reportNumbers: async () => [LAB, NATURAL] }).incrementalSync({ organizationId: TEST_ORG, cursor: unsorted }));
    expect(lastCursor(night)).toBe(JSON.stringify({ looked: [NATURAL, LAB], found: { [NATURAL]: VALID.validFrom, [LAB]: VALID.validFrom }, refetch: [NATURAL, LAB, MELEE, MISSING], checked: "2026-11-10" }));
  });

  it("checks validity 1000 numbers to a request, and finishes the night only after the last", async () => {
    const numbers = Array.from({ length: 2001 }, (_, i) => String(230000000000 + i));
    const asked: number[] = [];
    let open = true;
    const client: HrdClient = {
      report: async () => ({ kind: "not_found" }),
      validities: async (list) => {
        asked.push(list.length);
        return open ? new Map(list.map((n) => [n, VALID])) : null;
      },
    };
    const found = Object.fromEntries(numbers.map((n) => [n, VALID.validFrom]));
    const c = hrdConnector({ apiToken: TOKEN, client, reportNumbers: async () => numbers, now: NOW });
    const batches = await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor: cursorOf({ looked: numbers, found }) }));
    expect(asked).toEqual([1000, 1000, 1]);
    asked.length = 0;
    const exact = numbers.slice(0, 1000);
    const one = await collect(hrdConnector({ apiToken: TOKEN, client, reportNumbers: async () => exact, now: NOW }).incrementalSync({ organizationId: TEST_ORG, cursor: cursorOf({ looked: exact, found: Object.fromEntries(exact.map((n) => [n, VALID.validFrom])) }) }));
    expect(asked).toEqual([1000]);
    expect(one.map((b) => (JSON.parse(b.cursor) as HrdCursor).checked)).toEqual(["2026-11-10"]);
    expect(batches.map((b) => (JSON.parse(b.cursor) as HrdCursor).checked)).toEqual([null, null, "2026-11-10"]);
    // HRD's clock says the window closed partway: the night isn't marked checked, and the rest waits.
    asked.length = 0;
    let calls = 0;
    client.validities = async (list) => (asked.push(list.length), calls++ === 0 ? new Map(list.map((n) => [n, VALID])) : null);
    const partial = await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor: cursorOf({ looked: numbers, found }) }));
    expect(asked).toEqual([1000, 1000]);
    expect(partial.map((b) => (JSON.parse(b.cursor) as HrdCursor).checked)).toEqual([null]);
    open = false;
    expect(await collect(hrdConnector({ apiToken: TOKEN, client: { ...client, validities: async () => null }, reportNumbers: async () => numbers, now: NOW }).incrementalSync({ organizationId: TEST_ORG, cursor: cursorOf({ looked: numbers, found }) }))).toEqual([]);
  });

  it("asks nothing when nothing was found, and nothing at all for an empty list", async () => {
    const mock = hrdDocMock(data());
    expect(await collect(connector(mock, { reportNumbers: async () => [MISSING] }).incrementalSync({ organizationId: TEST_ORG, cursor: null }))).toHaveLength(1);
    expect(mock.operations).toEqual([`report:${MISSING}`]);
    mock.operations.length = 0;
    expect(await collect(connector(mock, { reportNumbers: async () => [] }).incrementalSync({ organizationId: TEST_ORG, cursor: null }))).toEqual([]);
    expect(mock.operations).toEqual([]);
  });

  it("stops the sync on HRD's request limit, keeping what was already looked up", async () => {
    const mock = hrdDocMock(data());
    let calls = 0;
    const limited: typeof mock.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => (++calls > 2 ? new Response("", { status: 429 }) : mock.fetch(input, init)), { calls: mock.fetch.calls });
    const { memory, pipeline } = testPipeline();
    await expect(runSync({ connector: connector(mock, { fetch: limited, retries: 0 }), mode: "historical", pipeline, memory, organizationId: TEST_ORG, attempts: 1 })).rejects.toBeInstanceOf(HrdApiError);
    expect(memory.events.map((e) => e.payload.reportNumber)).toEqual([NATURAL, LAB]);
    expect(JSON.parse((await memory.getCheckpoint(TEST_ORG, "hrd", "historical"))!)).toMatchObject({ looked: [NATURAL, LAB] });
  });

  it("runs the same way incrementally, takes no webhooks, and declares no writes", async () => {
    const c = connector();
    const incremental = (await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor: null }))).flatMap((b) => b.events);
    expect(incremental).toEqual(await eventsOf());
    expect(c.source).toBe("hrd");
    expect(c.handleWebhook).toBeUndefined();
    expect(c.writes).toBe(HRD_WRITES);
    expect(HRD_WRITES).toEqual([]);
    expect(await assertWritesRefused(c)).toEqual([]);
    expect(hrdConnector({ apiToken: TOKEN, reportNumbers: async () => [] }).source).toBe("hrd");
  });

  it("rejects a checkpoint it didn't write", () => {
    expect(parseHrdCursor(null)).toBeNull();
    const good = { looked: [NATURAL], found: { [NATURAL]: "", [JEWEL]: "2025-01-01" }, refetch: [JEWEL], checked: "2026-11-10" };
    expect(parseHrdCursor(JSON.stringify(good))).toEqual(good);
    expect(parseHrdCursor(cursorOf({}))).toEqual({ looked: [], found: {}, refetch: [], checked: null });
    for (const bad of [
      "null",
      "[]",
      "{}",
      "not json",
      JSON.stringify({ ...good, looked: NATURAL }),
      JSON.stringify({ ...good, looked: ["../x"] }),
      JSON.stringify({ ...good, found: null }),
      JSON.stringify({ ...good, found: [] }),
      JSON.stringify({ ...good, found: { "../x": "" } }),
      JSON.stringify({ ...good, found: { [NATURAL]: "soon" } }),
      JSON.stringify({ ...good, found: { [NATURAL]: 5 } }),
      JSON.stringify({ ...good, refetch: "x" }),
      JSON.stringify({ ...good, refetch: ["../x"] }),
      JSON.stringify({ ...good, checked: "x2026-11-10" }),
      JSON.stringify({ ...good, checked: "2026-11-10x" }),
      JSON.stringify({ ...good, checked: undefined }),
    ]) {
      expect(() => parseHrdCursor(bad), bad).toThrow("HRD checkpoint is not in the expected shape");
    }
  });
});
