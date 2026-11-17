import { memoryFileSource, supplierInvoicesConnector } from "@karatos/connectors";
import { DEMO_SUPPLIER_LINES, type DemoCalendar } from "../store.js";
import { csvLine, dollarsText, type DemoSource } from "./source.js";

/** Each supplier's invoice and memo exports, one folder per supplier, the way a store saves them. */
export function supplierExports(calendar: DemoCalendar): Record<string, Record<string, string>> {
  const folders: Record<string, Record<string, string>> = {};
  for (const l of DEMO_SUPPLIER_LINES) {
    const file = `${l.type.toLowerCase()}-${l.number}.csv`;
    const rows = [
      "Type,Document Number,Document Date,SKU,Description,Stone,Qty,Unit Cost,Amount,Terms,Statement",
      csvLine([l.type, l.number, calendar.usDate(l.daysAgo), l.sku, l.description, l.stone, 1, dollarsText(l.costCents), dollarsText(l.costCents), l.terms, l.statement]),
    ];
    (folders[l.supplier] ??= {})[file] = rows.join("\n");
  }
  return folders;
}

export const supplierInvoicesSource: DemoSource = {
  integration: "supplier_invoices",
  role: "Supplier invoices and memos: what each piece cost and when memo goods go back",
  connector: (calendar) =>
    supplierInvoicesConnector({
      suppliers: Object.entries(supplierExports(calendar)).map(([id, files]) => ({ id, source: memoryFileSource(files, calendar.at(0, 6)) })),
      now: () => calendar.now,
    }),
};
