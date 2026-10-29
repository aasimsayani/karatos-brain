import { memoryTokenStore, quickBooksConnector } from "@karatos/connectors";
import { QUICKBOOKS_TEST_REALM, quickBooksDocMock, type QuickBooksMockRecord } from "@karatos/connector-testkit";
import type { DemoCalendar } from "../store.js";
import type { DemoSource } from "./source.js";

// Made-up app credentials the mock checks for, assembled at runtime so no key-shaped string sits in the repository.
const CLIENT = ["AB", "demo", "x".repeat(40)].join("");
const PASS = ["demo", "pass", "x".repeat(28)].join("-");
const REFRESH = ["RT", "DEMO", "x".repeat(12)].join("-");

interface DemoInvoice {
  number: string;
  customer: [id: string, name: string];
  issuedDaysAgo: number;
  dueDaysAgo: number;
  total: number;
  balance: number;
  line: string;
}

/** Trade and special-order invoices. Two are over 30 days past due. */
export const DEMO_INVOICES: DemoInvoice[] = [
  { number: "INV-2101", customer: ["1", "Demo Interiors Trade Account"], issuedDaysAgo: 82, dueDaysAgo: 52, total: 3_450, balance: 3_450, line: "Six sterling silver cuff links, engraved" },
  { number: "INV-2102", customer: ["2", "Sample Events Group"], issuedDaysAgo: 68, dueDaysAgo: 38, total: 2_800, balance: 1_200, line: "Bridal party pendants, 8 pieces" },
  { number: "INV-2103", customer: ["3", "Example Corporate Gifts"], issuedDaysAgo: 45, dueDaysAgo: 15, total: 1_960, balance: 0, line: "Service award lapel pins, 14K" },
  { number: "INV-2104", customer: ["1", "Demo Interiors Trade Account"], issuedDaysAgo: 20, dueDaysAgo: -10, total: 2_150, balance: 2_150, line: "Custom 14K signet ring, deposit invoiced" },
];

function records(calendar: DemoCalendar): Record<string, QuickBooksMockRecord[]> {
  const meta = (days: number) => ({ CreateTime: calendar.at(days, 14), LastUpdatedTime: calendar.at(Math.max(days - 1, 0), 14) });
  const customers = [...new Map(DEMO_INVOICES.map((i) => [i.customer[0], i.customer[1]])).entries()].map(([id, name]) => ({
    Id: id,
    SyncToken: "0",
    MetaData: meta(300),
    DisplayName: name,
    PrimaryEmailAddr: { Address: `ap${id}@customer.example` },
    Balance: DEMO_INVOICES.filter((i) => i.customer[0] === id).reduce((sum, i) => sum + i.balance, 0),
    Active: true,
  }));
  const invoices = DEMO_INVOICES.map((inv, n) => ({
    Id: String(500 + n),
    SyncToken: "0",
    MetaData: meta(inv.issuedDaysAgo),
    DocNumber: inv.number,
    TxnDate: calendar.date(inv.issuedDaysAgo),
    DueDate: calendar.date(inv.dueDaysAgo),
    CustomerRef: { value: inv.customer[0], name: inv.customer[1] },
    TotalAmt: inv.total,
    Balance: inv.balance,
    CurrencyRef: { value: "USD" },
    Line: [
      { Id: "1", LineNum: 1, Amount: inv.total, DetailType: "SalesItemLineDetail", Description: inv.line, SalesItemLineDetail: { Qty: 1, UnitPrice: inv.total } },
      { Amount: inv.total, DetailType: "SubTotalLineDetail", SubTotalLineDetail: {} },
    ],
  }));
  return { Customer: customers, Invoice: invoices };
}

export const quickBooksSource: DemoSource = {
  integration: "quickbooks",
  role: "The books: invoices to trade accounts and what they still owe",
  connector: (calendar) => {
    const mock = quickBooksDocMock({ entities: records(calendar), refreshToken: REFRESH, now: () => calendar.now });
    return quickBooksConnector({
      clientId: CLIENT,
      clientSecret: PASS,
      realmId: QUICKBOOKS_TEST_REALM,
      environment: "sandbox",
      tokens: memoryTokenStore(REFRESH),
      fetch: mock.fetch,
      sleep: async () => {},
      now: () => calendar.now,
    });
  },
};
