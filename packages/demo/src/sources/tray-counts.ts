import { memoryFileSource, rfidCountsConnector } from "@karatos/connectors";
import type { DemoCalendar } from "../store.js";
import { csvLine, type DemoSource } from "./source.js";

interface DemoTag {
  tag: string;
  sku: string;
  /** Found where it belongs, missing, or read in another tray. */
  status: "OK" | "Missing" | "Wrong tray";
}

/** The bridal case's tags. Each piece in it carries its own RFID tag. */
const BRIDAL: DemoTag[] = [
  { tag: "EST-1001-01", sku: "ES-1001", status: "OK" },
  { tag: "EST-1002-01", sku: "ES-1002", status: "OK" },
  { tag: "EST-1002-02", sku: "ES-1002", status: "OK" },
  { tag: "EST-1005-01", sku: "ES-1005", status: "OK" },
  { tag: "EST-1005-02", sku: "ES-1005", status: "OK" },
  { tag: "EST-1011-01", sku: "ES-1011", status: "OK" },
];

/** The fashion case, where last night's count came up short. */
const FASHION: DemoTag[] = [
  { tag: "EST-1003-01", sku: "ES-1003", status: "OK" },
  { tag: "EST-1006-01", sku: "ES-1006", status: "Missing" },
  { tag: "EST-1008-01", sku: "ES-1008", status: "OK" },
  { tag: "EST-1009-01", sku: "ES-1009", status: "Missing" },
  { tag: "EST-1009-02", sku: "ES-1009", status: "OK" },
  { tag: "EST-1010-01", sku: "ES-1010", status: "OK" },
  { tag: "EST-1004-01", sku: "ES-1004", status: "Wrong tray" },
];

/**
 * Each night's close-out count from the RFID reader, one file a night.
 * The bridal case has counted clean all week. Last night the fashion case
 * came up two pieces short (the tennis bracelet and a diamond pendant),
 * and a silver chain was read there that belongs in another case.
 */
export function trayCountExports(calendar: DemoCalendar): Record<string, string> {
  const files: Record<string, string> = {};
  const header = "Session ID,Tray,Tag,SKU,Scanned At,Staff,Status";
  for (let night = 6; night >= 1; night--) {
    const at = calendar.at(night, 22).replace(/\.\d{3}Z$/, "Z");
    const rows = [header, ...BRIDAL.map((t) => csvLine([`N${night}-B`, "Bridal case", t.tag, t.sku, at, "Associate 2", "OK"]))];
    const fashion = night === 1 ? FASHION : FASHION.filter((t) => t.status !== "Wrong tray").map((t) => ({ ...t, status: "OK" as const }));
    rows.push(...fashion.map((t) => csvLine([`N${night}-F`, "Fashion case", t.tag, t.sku, t.status === "Missing" ? undefined : at, "Associate 3", t.status])));
    files[`count-${calendar.date(night)}.csv`] = rows.join("\n");
  }
  return files;
}

export const trayCountsSource: DemoSource = {
  integration: "rfid_counts",
  role: "Each night's RFID count of every case, tag by tag",
  connector: (calendar) => rfidCountsConnector({ source: memoryFileSource(trayCountExports(calendar), calendar.at(0, 6)), now: () => calendar.now }),
};
