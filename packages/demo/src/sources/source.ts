import type { Connector } from "@karatos/core";
import type { DemoCalendar } from "../store.js";

/** One system the demo store uses, served from made-up data through its real connector. */
export interface DemoSource {
  /** Catalog id of the integration. */
  integration: string;
  /** What the store uses it for, one line for the dashboard. */
  role: string;
  connector(calendar: DemoCalendar): Connector;
}

/** One CSV line, quoting fields that need it. */
export function csvLine(fields: (string | number | undefined)[]): string {
  return fields
    .map((f) => {
      const text = f === undefined ? "" : String(f);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    })
    .join(",");
}

export const dollarsText = (cents: number) => (cents / 100).toFixed(2);
