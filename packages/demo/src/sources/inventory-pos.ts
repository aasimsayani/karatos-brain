import { inventoryPosConnector, memoryFileSource } from "@karatos/connectors";
import { DEMO_CUSTOMERS, DEMO_ITEMS, DEMO_SALES, type DemoCalendar } from "../store.js";
import { csvLine, dollarsText, type DemoSource } from "./source.js";

/** The exports a jewelry POS writes each night: items received, customers and sales. */
export function posExports(calendar: DemoCalendar): Record<string, string> {
  const items = [
    "SKU,Title,Category,Metal,Karat,Weight (g),Cost,Retail Price,Quantity,Vendor,On Memo,Received",
    ...DEMO_ITEMS.map((i) =>
      csvLine([
        i.sku,
        i.title,
        i.category,
        i.metal,
        i.karat === undefined ? undefined : `${i.karat}K`,
        i.weightGrams,
        dollarsText(i.costCents),
        dollarsText(i.retailCents),
        i.quantity,
        i.vendor,
        i.onMemo ? "Yes" : "No",
        calendar.usDate(i.receivedDaysAgo),
      ]),
    ),
  ];
  const customers = [
    "Customer ID,Name,Marketing Opt In,Updated",
    ...DEMO_CUSTOMERS.map((c) => csvLine([c.id, c.name, c.optIn ? "Yes" : "No", calendar.usDate(600)])),
  ];
  const sales = [
    "Sale ID,Date,SKU,Quantity,Unit Price,Discount,Sale Total,Payment Method,Customer ID,Salesperson,Channel,Original Sale ID,Return ID",
    ...DEMO_SALES.map((s) => {
      const quantity = s.returnOf ? -s.quantity : s.quantity;
      return csvLine([
        s.returnOf ?? s.saleId,
        calendar.usDate(s.daysAgo),
        s.sku,
        quantity,
        dollarsText(s.unitCents),
        "0.00",
        dollarsText(s.unitCents * quantity),
        s.tender,
        s.customerId,
        "Associate 1",
        "Store",
        s.returnOf,
        s.returnOf ? s.saleId : undefined,
      ]);
    }),
  ];
  return { "items.csv": items.join("\n"), "customers.csv": customers.join("\n"), "sales.csv": sales.join("\n") };
}

export const inventoryPosSource: DemoSource = {
  integration: "inventory_pos",
  role: "Point of sale exports: the case, customers and every sale",
  connector: (calendar) => inventoryPosConnector({ source: memoryFileSource(posExports(calendar), calendar.at(0, 6)), now: () => calendar.now }),
};
