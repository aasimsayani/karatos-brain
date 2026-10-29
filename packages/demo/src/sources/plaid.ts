import { plaidConnector } from "@karatos/connectors";
import { plaidDocMock, type PlaidMockAccount, type PlaidMockChange, type PlaidMockTransaction } from "@karatos/connector-testkit";
import { DEMO_CASH_DEPOSITS, type DemoCalendar } from "../store.js";
import type { DemoSource } from "./source.js";

// Made-up credentials the mock checks for, assembled at runtime so no key-shaped string sits in the repository.
const CLIENT = ["demo", "client", "x".repeat(16)].join("-");
const PASS = ["demo", "pass", "x".repeat(16)].join("-");
const TOKEN = ["access", "sandbox", "x".repeat(16)].join("-");

const balances = (current: number, available: number | null, limit: number | null = null) => ({ available, current, limit, iso_currency_code: "USD", unofficial_currency_code: null });

export const DEMO_ACCOUNTS: PlaidMockAccount[] = [
  { account_id: "acct_demo_operating", name: "Operating Checking", official_name: "Demo Bank Business Checking", mask: "0101", type: "depository", subtype: "checking", balances: balances(84_213.55, 83_900.12) },
  { account_id: "acct_demo_reserve", name: "Tax Reserve Savings", official_name: "Demo Bank Business Savings", mask: "0102", type: "depository", subtype: "savings", balances: balances(31_500, 31_500) },
  { account_id: "acct_demo_card", name: "Business Card", official_name: "Demo Bank Business Card", mask: "0103", type: "credit", subtype: "credit card", balances: balances(6_842.17, 18_157.83, 25_000) },
];

/** Thirty days of the store's bank activity. Plaid signs money out positive. */
export function demoTransactions(calendar: DemoCalendar): PlaidMockTransaction[] {
  let n = 0;
  const txn = (daysAgo: number, account: string, amount: number, name: string, merchant: string | null = null): PlaidMockTransaction => ({
    transaction_id: `txn_demo_${++n}`,
    account_id: account,
    amount,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
    date: calendar.date(daysAgo),
    authorized_date: calendar.date(daysAgo),
    pending: false,
    name,
    merchant_name: merchant,
    payment_channel: "other",
  });
  const op = "acct_demo_operating";
  return [
    ...DEMO_CASH_DEPOSITS.map((d) => txn(d.daysAgo, op, -d.cents / 100, "CASH DEPOSIT BRANCH 7")),
    ...[28, 21, 14, 7].map((d) => txn(d, op, -6_240.5 - d * 10, "CARD SETTLEMENT DEMO PAYMENTS")),
    txn(26, op, 4_850, "ACH DEMO REFINING CO", "Demo Refining Co"),
    txn(20, op, 12_400, "WIRE DEMO BRIDAL SUPPLY", "Sample Bridal Supply"),
    txn(15, op, 9_850, "PAYROLL DEMO PAYROLL SVC", "Demo Payroll"),
    txn(1, op, 9_850, "PAYROLL DEMO PAYROLL SVC", "Demo Payroll"),
    txn(10, op, 3_200, "ACH DEMO PROPERTY MGMT RENT", "Demo Property Management"),
    txn(18, "acct_demo_card", 642.3, "DEMO FINDINGS CO", "Demo Findings Co"),
    txn(9, "acct_demo_card", 1_288, "DEMO PACKAGING SUPPLY", "Demo Packaging"),
  ];
}

export const plaidSource: DemoSource = {
  integration: "plaid",
  role: "Bank balances and transactions, including cash deposits",
  connector: (calendar) => {
    const changes: PlaidMockChange[] = demoTransactions(calendar).map((transaction) => ({ kind: "added", transaction }));
    const mock = plaidDocMock({ clientId: CLIENT, secret: PASS, accessToken: TOKEN, itemId: "item_demo_1", accounts: DEMO_ACCOUNTS, changes });
    return plaidConnector({ clientId: CLIENT, secret: PASS, accessToken: TOKEN, environment: "sandbox", fetch: mock.fetch, sleep: async () => {}, now: () => calendar.now });
  },
};
