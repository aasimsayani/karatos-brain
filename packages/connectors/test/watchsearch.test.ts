import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import { TEST_ORG, assertSynthetic, checkConnectorSync, testPipeline } from "@karatos/connector-testkit";
import {
  ChatExportError,
  WatchExportError,
  WatchSearchKeyError,
  amountOf,
  brandIn,
  chatDateOrder,
  conditionIn,
  directorySource,
  groupOf,
  memoryFileSource,
  offersIn,
  parseChat,
  parseWatchSearchCursor,
  dealerRef,
  priceIn,
  referenceIn,
  setIn,
  sha256,
  sideIn,
  watchSearchConnector,
  yearIn,
  type FileSource,
  type WatchOfferEvent,
  type WatchSearchCursor,
  type WatchSearchOptions,
} from "../src/index.js";

const NOW = () => new Date("2026-10-20T00:00:00Z");
const SCHEMAS = combineDepartments(RETAIL_DEPARTMENTS).payloadSchemas;
// Assembled at runtime so no key-shaped string sits in the repository.
const KEY = ["test", "dealer", "key", "0".repeat(24)].join("-");

const LRM = "‎";
const NNBSP = " ";

// An iPhone export: bracketed day-first timestamps with seconds.
const ALPHA = [
  `[12/10/2026, 09:00:00] Test Group Alpha: ${LRM}Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.`,
  "[12/10/2026, 09:01:12] Test Dealer 1: WTS",
  "Rolex 126610LN 2023 full set $14,500",
  "AP 15500ST blue 03/2024 B&P $38.5k",
  "[12/10/2026, 09:05:40] Test Dealer 2: LF Rolex 126610LN any year",
  `[13/10/2026, 18:22:03] ${LRM}Test Dealer 3: ${LRM}image omitted`,
  "[13/10/2026, 18:23:10] Test Dealer 3: Looking for Rolex 126610LN, full set only",
  "[14/10/2026, 07:45:00] +1 212 555 0101: WTB RLX 126610LN unworn",
  "[14/10/2026, 07:50:00] Test Dealer 1: Good morning all",
  "[15/10/2026, 11:11:11] Test Dealer 4: Patek 5711/1A-010 2021 B&P HKD 1.05m <This message was edited>",
].join("\r\n");

// An Android export: month-first dates with two-digit years and AM/PM.
const BETA = [
  `10/13/26, 2:03${NNBSP}PM - Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.`,
  `10/13/26, 2:04${NNBSP}PM - Test Dealer 5: Available today`,
  "Omega 310.30.42.50.01.001 new €6.200",
  "Cartier WSSA0018 pre-owned watch only 5,900 USD",
  `10/13/26, 2:10${NNBSP}PM - Test Dealer 5 added Test Dealer 6`,
  `10/14/26, 9:15${NNBSP}AM - Test Dealer 6: Richard Mille RM 011 wanted, call +1 212 555 0102`,
  `10/14/26, 9:20${NNBSP}AM - Test Dealer 1: <Media omitted>`,
].join("\n");

const FILES = () => ({
  "WhatsApp Chat with Test Group Alpha.txt": ALPHA,
  "WhatsApp Chat - Test Group Beta.txt": BETA,
  "notes.csv": "not,a,chat",
});

const connector = (source: FileSource = memoryFileSource(FILES()), options: Partial<WatchSearchOptions> = {}) =>
  watchSearchConnector({ source, dealerKey: KEY, batchSize: 4, now: NOW, ...options });

async function collect(pages: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const page of pages) out.push(page);
  return out;
}

const eventsOf = async (c = connector()) => (await collect(c.historicalImport({ organizationId: TEST_ORG, cursor: null }))).flatMap((b) => b.events) as WatchOfferEvent[];
const dealer = (name: string) => dealerRef(KEY, name);

describe("WhatsApp chat exports", () => {
  it("reads iPhone exports, joining continuation lines and dropping system lines and media", () => {
    const messages = parseChat(ALPHA, { fileName: "alpha.txt" });
    expect(messages.map((m) => [m.at, m.sender, m.line])).toEqual([
      ["2026-10-12T09:00:00.000Z", "Test Group Alpha", 1],
      ["2026-10-12T09:01:12.000Z", "Test Dealer 1", 2],
      ["2026-10-12T09:05:40.000Z", "Test Dealer 2", 5],
      ["2026-10-13T18:23:10.000Z", "Test Dealer 3", 7],
      ["2026-10-14T07:45:00.000Z", "+1 212 555 0101", 8],
      ["2026-10-14T07:50:00.000Z", "Test Dealer 1", 9],
      ["2026-10-15T11:11:11.000Z", "Test Dealer 4", 10],
    ]);
    expect(messages[1]!.text).toBe("WTS\nRolex 126610LN 2023 full set $14,500\nAP 15500ST blue 03/2024 B&P $38.5k");
    expect(messages[6]!.text).toBe("Patek 5711/1A-010 2021 B&P HKD 1.05m");
  });

  it("reads Android exports with two-digit years, AM and PM, and skips lines with no sender", () => {
    const messages = parseChat(BETA, { fileName: "beta.txt" });
    expect(messages.map((m) => [m.at, m.sender])).toEqual([
      ["2026-10-13T14:04:00.000Z", "Test Dealer 5"],
      ["2026-10-14T09:15:00.000Z", "Test Dealer 6"],
    ]);
  });

  it("reads times at the phone's offset, and dotted times", () => {
    const [m] = parseChat("22.10.2026, 23.15 - Test Dealer 1: hi", { fileName: "a.txt", utcOffset: "+08:00" });
    expect(m!.at).toBe("2026-10-22T15:15:00.000Z");
    const [n] = parseChat("[10/22/2026, 12:05:09 a.m.] Test Dealer 1: hi", { fileName: "a.txt" });
    expect(n!.at).toBe("2026-10-22T00:05:09.000Z");
  });

  it("works out the date order, takes the setting when it can't, and rejects one that contradicts the file", () => {
    expect(chatDateOrder([{ a: 13, b: 1 }], "auto", "f")).toBe("dmy");
    expect(chatDateOrder([{ a: 1, b: 13 }], "auto", "f")).toBe("mdy");
    expect(chatDateOrder([{ a: 1, b: 2 }], "mdy", "f")).toBe("mdy");
    expect(chatDateOrder([{ a: 13, b: 2 }], "dmy", "f")).toBe("dmy");
    expect(() => chatDateOrder([{ a: 1, b: 2 }], "auto", "f.txt")).toThrow("f.txt: every date could be day-first or month-first; set WATCHSEARCH_DATE_ORDER to dmy or mdy");
    expect(() => chatDateOrder([{ a: 13, b: 2 }], "mdy", "f.txt")).toThrow("the dates are dmy, but WATCHSEARCH_DATE_ORDER says mdy");
    expect(() => chatDateOrder([{ a: 13, b: 2 }, { a: 2, b: 13 }], "auto", "f.txt")).toThrow(ChatExportError);
    expect(parseChat("01/02/2026, 10:00 - Test Dealer 1: hi", { fileName: "a.txt", dateOrder: "mdy" })[0]!.at).toBe("2026-01-02T10:00:00.000Z");
    expect(parseChat("01/02/2026, 10:00 - Test Dealer 1: hi", { fileName: "a.txt", dateOrder: "dmy" })[0]!.at).toBe("2026-02-01T10:00:00.000Z");
  });

  it("rejects a timestamp that isn't a real date or time, naming the line", () => {
    expect(() => parseChat("13/01/2026, 10:00 - A: hi\n31/02/2026, 10:00 - A: hi", { fileName: "a.txt" })).toThrow("a.txt:2: the timestamp isn't a real date and time");
    expect(() => parseChat("13/01/2026, 25:00 - A: hi", { fileName: "a.txt" })).toThrow(ChatExportError);
    expect(() => parseChat("13/01/2026, 13:00 PM - A: hi", { fileName: "a.txt" })).toThrow(ChatExportError);
  });

  it("drops deleted messages, placeholders and empty messages, and text before the first message", () => {
    const text = [
      "exported by a tool",
      "13/01/2026, 10:00 - Test Dealer 1: This message was deleted",
      "13/01/2026, 10:01 - Test Dealer 1: You deleted this message",
      "13/01/2026, 10:02 - Test Dealer 1: sticker omitted",
      "13/01/2026, 10:03 - Test Dealer 1: null",
      "13/01/2026, 10:04 - Test Dealer 1: ",
      "13/01/2026, 10:05 - Test Dealer 1: kept",
    ].join("\n");
    expect(parseChat(text, { fileName: "a.txt" }).map((m) => m.text)).toEqual(["kept"]);
  });
});

describe("watch offers in a message", () => {
  const at = { now: NOW() };

  it("finds brands by name and by capital shorthand, earliest first", () => {
    expect(brandIn("WTS Rolex 126610LN")?.brand).toBe("Rolex");
    expect(brandIn("AP 15500ST")?.brand).toBe("Audemars Piguet");
    expect(brandIn("an ap of tea")).toBeNull();
    expect(brandIn("Royal Oak 15500ST")?.brand).toBe("Audemars Piguet");
    expect(brandIn("VC 4500V overseas")?.brand).toBe("Vacheron Constantin");
    expect(brandIn("Bvlgari Octo 103011")?.brand).toBe("Bulgari");
    expect(brandIn("Tudor or Rolex")?.brand).toBe("Tudor");
    expect(brandIn("Rolexes")).toBeNull();
  });

  it("tells selling from looking for, and leaves a line that says both undecided", () => {
    expect(sideIn("WTS 126610LN")).toBe("selling");
    expect(sideIn("Available now")).toBe("selling");
    expect(sideIn("WTB 126610LN")).toBe("looking_for");
    expect(sideIn("LF 126610LN")).toBe("looking_for");
    expect(sideIn("Looking for a Daytona")).toBe("looking_for");
    expect(sideIn("selling or buying")).toBeNull();
    expect(sideIn("126610LN")).toBeNull();
  });

  it("reads prices in the trade's styles without guessing the currency", () => {
    expect(priceIn("$14,500")).toMatchObject({ priceMinor: 1_450_000, currency: "USD" });
    expect(priceIn("$14,500.50")).toMatchObject({ priceMinor: 1_450_050, currency: "USD" });
    expect(priceIn("€6.200")).toMatchObject({ priceMinor: 620_000, currency: "EUR" });
    expect(priceIn("£ 9 950")).toMatchObject({ priceMinor: 995_000, currency: "GBP" });
    expect(priceIn("CHF 12'400")).toMatchObject({ priceMinor: 1_240_000, currency: "CHF" });
    expect(priceIn("38.5k USD")).toMatchObject({ priceMinor: 3_850_000, currency: "USD" });
    expect(priceIn("HKD 1.05m")).toMatchObject({ priceMinor: 105_000_000, currency: "HKD" });
    expect(priceIn("HK$ 98,000")).toMatchObject({ priceMinor: 9_800_000, currency: "HKD" });
    expect(priceIn("S$21k")).toMatchObject({ priceMinor: 2_100_000, currency: "SGD" });
    expect(priceIn("1,900,000 JPY")).toMatchObject({ priceMinor: 1_900_000, currency: "JPY" });
    expect(priceIn("AED 55000")).toMatchObject({ priceMinor: 5_500_000, currency: "AED" });
    expect(priceIn("$14,500 2023")).toMatchObject({ priceMinor: 1_450_000 });
    // A bare amount only counts with the store's own currency, and 18k gold is never a price.
    expect(priceIn("14.5k")).toBeNull();
    expect(priceIn("14.5k", "USD")).toMatchObject({ priceMinor: 1_450_000, currency: "USD" });
    expect(priceIn("18k gold", "USD")).toBeNull();
    expect(priceIn("41mm", "USD")).toBeNull();
    expect(priceIn("$0")).toBeNull();
  });

  it("reads amounts only when their separators read one way", () => {
    expect(amountOf("14,500", undefined)).toBe(14_500);
    expect(amountOf("14.500", undefined)).toBe(14_500);
    expect(amountOf("14 500", undefined)).toBe(14_500);
    expect(amountOf("1,234.56", undefined)).toBe(1_234.56);
    expect(amountOf("1.234,56", undefined)).toBe(1_234.56);
    expect(amountOf("14.50", undefined)).toBe(14.5);
    expect(amountOf("14,5", "k")).toBe(14_500);
    expect(amountOf("2", "mil")).toBe(2_000_000);
    expect(amountOf("1234.56", undefined)).toBe(1_234.56);
    expect(amountOf("1234,56", undefined)).toBe(1_234.56);
    expect(amountOf("1,234,56", undefined)).toBeNull();
    expect(amountOf("1.234.56", undefined)).toBeNull();
    expect(amountOf("1,2", undefined)).toBeNull();
    expect(amountOf("1,000.5", "k")).toBeNull();
  });

  it("reads the card year, and ignores years that haven't happened", () => {
    expect(yearIn("2023 full set", NOW())?.year).toBe(2023);
    expect(yearIn("card 03/2024", NOW())?.year).toBe(2024);
    expect(yearIn("2027 release", NOW())?.year).toBe(2027);
    expect(yearIn("2028 release", NOW())).toBeNull();
    expect(yearIn("ref 12023", NOW())).toBeNull();
    expect(yearIn("no year", NOW())).toBeNull();
  });

  it("reads condition and what comes with the watch", () => {
    expect(conditionIn("BNIB")).toBe("new");
    expect(conditionIn("unworn, stickers")).toBe("new");
    expect(conditionIn("like new")).toBe("pre_owned");
    expect(conditionIn("mint")).toBe("pre_owned");
    expect(conditionIn("new card 2024")).toBeUndefined();
    expect(conditionIn("blue dial")).toBeUndefined();
    expect(setIn("full set")).toBe("full_set");
    expect(setIn("B&P")).toBe("full_set");
    expect(setIn("box and papers")).toBe("full_set");
    expect(setIn("watch only")).toBe("watch_only");
    expect(setIn("box only")).toBe("box_only");
    expect(setIn("card only")).toBe("papers_only");
    expect(setIn("blue dial")).toBeUndefined();
  });

  it("reads references in each house's style, skipping sizes and phone numbers", () => {
    expect(referenceIn("126610LN")).toBe("126610LN");
    expect(referenceIn("15202ST.OO.1240ST.01 jumbo")).toBe("15202ST.OO.1240ST.01");
    expect(referenceIn("5711/1A-010")).toBe("5711/1A-010");
    expect(referenceIn("310.30.42.50.01.001")).toBe("310.30.42.50.01.001");
    expect(referenceIn("wssa0018")).toBe("WSSA0018");
    expect(referenceIn("RM 011")).toBe("RM011");
    expect(referenceIn("41mm 18k 126610LN")).toBe("126610LN");
    expect(referenceIn("40.5mm 126610LN")).toBe("126610LN");
    expect(referenceIn("750g 126610LN")).toBe("126610LN");
    expect(referenceIn("Daytona green")).toBeNull();
    expect(referenceIn("x2 GMT")).toBeNull();
    expect(referenceIn("2125550101")).toBeNull();
  });

  it("finds one offer per line, carrying the message's side to the lines under it", () => {
    expect(offersIn("WTS\nRolex 126610LN 2023 full set $14,500\nAP 15500ST blue 03/2024 B&P $38.5k", at)).toEqual([
      { side: "selling", brand: "Rolex", reference: "126610LN", priceMinor: 1_450_000, currency: "USD", year: 2023, set: "full_set", part: 1 },
      { side: "selling", brand: "Audemars Piguet", reference: "15500ST", priceMinor: 3_850_000, currency: "USD", year: 2024, set: "full_set", part: 2 },
    ]);
  });

  it("never reads a year, a price or a phone number as the reference", () => {
    expect(offersIn("WTS 2023 Rolex 126610LN", at)).toMatchObject([{ reference: "126610LN", year: 2023 }]);
    expect(offersIn("WTS Tudor $2025 79360N", at)).toEqual([{ side: "selling", brand: "Tudor", reference: "79360N", priceMinor: 202_500, currency: "USD", part: 0 }]);
    expect(offersIn("Call +1 212 555 0101 WTB Rolex 126610LN", at)).toMatchObject([{ reference: "126610LN" }]);
  });

  it("takes a price as selling, and skips a line with no side and no price", () => {
    expect(offersIn("Patek 5711/1A-010 2021 HKD 1.05m", at)).toMatchObject([{ side: "selling", reference: "5711/1A-010" }]);
    expect(offersIn("Rolex 126610LN, thoughts?", at)).toEqual([]);
  });

  it("lets a line's own side win over the message's", () => {
    expect(offersIn("WTS\nRolex 126610LN $14k\nWTB Rolex 126710BLRO", at).map((o) => o.side)).toEqual(["selling", "looking_for"]);
  });

  it("keeps a side said on a line with a brand but no reference for the lines under it", () => {
    expect(offersIn("Selling some Rolex\n126610LN $14k\nRolex 116500LN", at)).toMatchObject([{ side: "selling", brand: "Rolex", reference: "116500LN", part: 2 }]);
  });

  it("drops chatter, and keeps no words beyond the offer's fields", () => {
    expect(offersIn("Good morning all\nanyone at the show?", at)).toEqual([]);
    const [offer] = offersIn("WTB Rolex 126610LN for my client Test Customer 1, call +1 212 555 0101", at);
    expect(offer).toEqual({ side: "looking_for", brand: "Rolex", reference: "126610LN", part: 0 });
  });
});

describe("TheWatchSearch connector", () => {
  it("uses only synthetic data in its fixtures", () => {
    assertSynthetic(FILES());
  });

  it("survives every runSync scenario, with every offer passing the buying department's schema", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(), payloadSchemas: SCHEMAS, expected: { ingested: 9 } });
    // Alpha's 6 offers in batches of 4, then Beta's 3.
    expect(result.full.batches).toBe(3);
    const cursor = JSON.parse(result.full.cursor!) as WatchSearchCursor;
    expect(cursor.current).toBeNull();
    expect(Object.keys(cursor.done).sort()).toEqual(["WhatsApp Chat - Test Group Beta.txt", "WhatsApp Chat with Test Group Alpha.txt"]);
    expect(cursor.done["WhatsApp Chat with Test Group Alpha.txt"]).toBe(sha256(ALPHA));
  });

  it("turns each offer into a watch_market.offer_seen event with only the offer's fields", async () => {
    const events = await eventsOf();
    expect(events.map((e) => [e.payload.side, e.payload.brand, e.payload.reference, e.payload.sourceRow])).toEqual([
      ["selling", "Omega", "310.30.42.50.01.001", "WhatsApp Chat - Test Group Beta.txt:3"],
      ["selling", "Cartier", "WSSA0018", "WhatsApp Chat - Test Group Beta.txt:4"],
      ["looking_for", "Richard Mille", "RM011", "WhatsApp Chat - Test Group Beta.txt:6"],
      ["selling", "Rolex", "126610LN", "WhatsApp Chat with Test Group Alpha.txt:3"],
      ["selling", "Audemars Piguet", "15500ST", "WhatsApp Chat with Test Group Alpha.txt:4"],
      ["looking_for", "Rolex", "126610LN", "WhatsApp Chat with Test Group Alpha.txt:5"],
      ["looking_for", "Rolex", "126610LN", "WhatsApp Chat with Test Group Alpha.txt:7"],
      ["looking_for", "Rolex", "126610LN", "WhatsApp Chat with Test Group Alpha.txt:8"],
      ["selling", "Patek Philippe", "5711/1A-010", "WhatsApp Chat with Test Group Alpha.txt:10"],
    ]);
    const omega = events[0]!;
    expect(omega).toMatchObject({ type: "watch_market.offer_seen", occurredAt: "2026-10-13T14:04:00.000Z", receivedAt: "2026-10-20T00:00:00.000Z" });
    expect(omega.payload).toEqual({
      offerId: omega.payload.offerId,
      side: "selling",
      brand: "Omega",
      reference: "310.30.42.50.01.001",
      priceMinor: 620_000,
      currency: "EUR",
      condition: "new",
      dealerRef: dealer("Test Dealer 5"),
      group: "Test Group Beta",
      sourceRow: "WhatsApp Chat - Test Group Beta.txt:3",
    });
    expect(omega.id).toBe(`watchsearch_${omega.payload.offerId}`);
    expect(omega.idempotencyKey).toBe(`watchsearch:${omega.payload.offerId}`);
    expect(events[8]!.payload).toMatchObject({ priceMinor: 105_000_000, currency: "HKD", year: 2021, set: "full_set" });
    expect(events[7]!.payload).toMatchObject({ condition: "new", dealerRef: dealer("+12125550101") });
    // No dealer names or numbers, and none of the messages' own words, leave the export.
    const stored = JSON.stringify(events);
    for (const text of ["Test Dealer", "555", "Good morning", "Available today", "any year", "blue", "edited"]) expect(stored, text).not.toContain(text);
  });

  it("gives an offer the same key when the export is taken again with more messages", async () => {
    const first = await eventsOf();
    const later = await eventsOf(connector(memoryFileSource({ ...FILES(), "WhatsApp Chat with Test Group Alpha.txt": `${ALPHA}\r\n[16/10/2026, 10:00:00] Test Dealer 2: WTB Tudor 79360N` })));
    expect(later.map((e) => e.idempotencyKey)).toEqual(expect.arrayContaining(first.map((e) => e.idempotencyKey)));
    expect(later).toHaveLength(first.length + 1);

    // Into the same store, only the new offer is stored.
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    await runSync({ connector: connector(), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const grown = memoryFileSource({ ...FILES() });
    grown.files["WhatsApp Chat with Test Group Alpha.txt"] = `${ALPHA}\r\n[16/10/2026, 10:00:00] Test Dealer 2: WTB Tudor 79360N`;
    // The unchanged Beta export is skipped by its checkpointed hash; the grown Alpha one is read again from the top.
    const report = await runSync({ connector: connector(grown), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 1, duplicates: 6, deadLettered: 0 });
  });

  it("keeps two offers apart when one message, or one minute, holds both", async () => {
    const text = [
      "[13/10/2026, 09:00:00] Test Dealer 1: WTS",
      "Rolex 126610LN $14,500",
      "Rolex 126610LN $14,900",
      "[13/10/2026, 09:00:00] Test Dealer 2: WTS",
      "Rolex 126610LN $14,500",
    ].join("\n");
    const events = await eventsOf(connector(memoryFileSource({ "Test Group.txt": text })));
    expect(events).toHaveLength(3);
    expect(new Set(events.map((e) => e.idempotencyKey)).size).toBe(3);
  });

  it("gives an offer the same key whenever it is read", async () => {
    const first = await eventsOf();
    const later = await eventsOf(connector(undefined, { now: () => new Date("2026-10-21T08:00:00Z") }));
    expect(later.map((e) => e.idempotencyKey)).toEqual(first.map((e) => e.idempotencyKey));
    expect(later[0]!.receivedAt).not.toBe(first[0]!.receivedAt);
  });

  it("reads prices written with the no-break spaces some phones use", async () => {
    const [event] = await eventsOf(connector(memoryFileSource({ "Test Group.txt": "[13/10/2026, 09:00:00] Test Dealer 1: WTS Rolex 126610LN $14\u00a0500" })));
    expect(event!.payload).toMatchObject({ priceMinor: 1_450_000, currency: "USD" });
  });

  it("keeps dealers as keyed references that match however a number is written", () => {
    expect(dealer("+1 212 555 0101")).toBe(dealer("+1 (212) 555-0101"));
    expect(dealer("Test Dealer 1")).toBe(dealer("  test   DEALER 1 "));
    expect(dealer("Test Dealer 1")).not.toBe(dealer("Test Dealer 2"));
    expect(dealer("Test Dealer 1")).not.toBe(dealerRef(`${KEY}x`, "Test Dealer 1"));
    expect(dealer("Test Dealer 1")).toMatch(/^watchsearch:dealer:[0-9a-f]{24}$/);
  });

  it("names the group from the export's file name, and rejects an export named only _chat", async () => {
    expect(groupOf("WhatsApp Chat with Test Group Alpha.txt")).toBe("Test Group Alpha");
    expect(groupOf("WhatsApp Chat - Test Group Beta.txt")).toBe("Test Group Beta");
    expect(groupOf("Test Group Gamma.TXT")).toBe("Test Group Gamma");
    expect(groupOf("_chat.txt")).toBeNull();
    expect(groupOf("WhatsApp Chat with .txt")).toBeNull();
    await expect(eventsOf(connector(memoryFileSource({ "_chat.txt": ALPHA })))).rejects.toThrow("_chat.txt: rename the export after its group");
  });

  it("stops on an export it can't read, naming the file", async () => {
    const error = await eventsOf(connector(memoryFileSource({ "Test Group.txt": "01/02/2026, 10:00 - Test Dealer 1: hi" }))).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WatchExportError);
    expect((error as WatchExportError).file).toBe("Test Group.txt");
    expect((error as Error).message).toBe("Test Group.txt: every date could be day-first or month-first; set WATCHSEARCH_DATE_ORDER to dmy or mdy");
    const ok = await eventsOf(connector(memoryFileSource({ "Test Group.txt": "01/02/2026, 10:00 - Test Dealer 1: WTB Rolex 126610LN" }), { dateOrder: "mdy" }));
    expect(ok[0]!.occurredAt).toBe("2026-01-02T10:00:00.000Z");
    const broken: FileSource = { ...memoryFileSource({ "Test Group.txt": "x" }), read: async () => Promise.reject(new RangeError("disk")) };
    await expect(eventsOf(connector(broken))).rejects.toThrow(RangeError);
    expect(new WatchExportError("a.txt", "a.txt: already named").message).toBe("a.txt: already named");
  });

  it("reads bare prices in the store's currency and times at the phone's offset", async () => {
    const text = "[13/10/2026, 09:00:00] Test Dealer 1: WTS Rolex 126610LN 14.5k";
    const plain = await eventsOf(connector(memoryFileSource({ "Test Group.txt": text })));
    expect(plain[0]!.payload).not.toHaveProperty("priceMinor");
    const priced = await eventsOf(connector(memoryFileSource({ "Test Group.txt": text }), { defaultCurrency: "USD", utcOffset: "+08:00" }));
    expect(priced[0]!.payload).toMatchObject({ priceMinor: 1_450_000, currency: "USD" });
    expect(priced[0]!.occurredAt).toBe("2026-10-13T01:00:00.000Z");
  });

  it("honours historyDays, keeping offers on the cutoff and dropping older ones", async () => {
    const text = ["[10/10/2026, 00:00:00] Test Dealer 1: WTB Rolex 126610LN", "[09/10/2026, 23:59:59] Test Dealer 1: WTB Rolex 116500LN"].join("\n");
    const events = await eventsOf(connector(memoryFileSource({ "Test Group.txt": text }), { historyDays: 10, dateOrder: "dmy" }));
    expect(events.map((e) => e.payload.reference)).toEqual(["126610LN"]);
  });

  it("checks its settings before reading anything", () => {
    const source = memoryFileSource({});
    expect(() => watchSearchConnector({ source, dealerKey: "short" })).toThrow(WatchSearchKeyError);
    expect(() => watchSearchConnector({ source, dealerKey: "x".repeat(31) })).toThrow("at least 32 characters");
    expect(() => watchSearchConnector({ source, dealerKey: KEY, defaultCurrency: "usd" })).toThrow(/defaultCurrency/);
    expect(() => watchSearchConnector({ source, dealerKey: KEY, utcOffset: "+8" })).toThrow(/utcOffset/);
    expect(() => watchSearchConnector({ source, dealerKey: KEY, utcOffset: "+15:00" })).toThrow(/utcOffset/);
    expect(() => watchSearchConnector({ source, dealerKey: KEY, batchSize: 0 })).toThrow(/batchSize/);
    expect(() => watchSearchConnector({ source, dealerKey: KEY, historyDays: 0 })).toThrow(/historyDays/);
    expect(() => watchSearchConnector({ source, dealerKey: KEY, historyDays: 1.5 })).toThrow(/historyDays/);
    expect(watchSearchConnector({ source, dealerKey: KEY, utcOffset: "-05:30", defaultCurrency: "EUR" }).source).toBe("watchsearch");
    expect(watchSearchConnector({ source, dealerKey: KEY, utcOffset: "Z" }).source).toBe("watchsearch");
  });

  it("runs the same way incrementally, writes nothing back, and takes no webhooks", async () => {
    const c = connector();
    const incremental = (await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor: null }))).flatMap((b) => b.events);
    expect(incremental).toEqual(await eventsOf());
    expect(c.writes).toEqual([]);
    expect(c.handleWebhook).toBeUndefined();
  });

  it("rejects a checkpoint it didn't write", () => {
    expect(parseWatchSearchCursor(null)).toBeNull();
    expect(() => parseWatchSearchCursor(JSON.stringify({ done: null, current: null }))).toThrow("WatchSearch import checkpoint is not in the expected shape");
  });

  it("reads a real folder of exports, skipping other files, hidden files and subfolders", async () => {
    const dir = await mkdtemp(join(tmpdir(), "watchsearch-"));
    await writeFile(join(dir, "WhatsApp Chat with Test Group Alpha.txt"), ALPHA);
    await writeFile(join(dir, ".Test Group.txt"), ALPHA);
    await writeFile(join(dir, "Test Group.zip"), "zip");
    await mkdir(join(dir, "Old Group.txt"));
    const events = await eventsOf(connector(directorySource(dir)));
    expect(new Set(events.map((e) => e.payload.group))).toEqual(new Set(["Test Group Alpha"]));
    expect(events).toHaveLength(6);
  });
});
