import { plaidConnector } from "@karatos/connectors";
import { plaidDocMock, type PlaidMockAccount, type PlaidMockChange, type PlaidMockTransaction } from "@karatos/connector-testkit";
import { DEMO_CASH_DEPOSITS, DEMO_SALES, type DemoCalendar } from "../store.js";
import type { DemoSource } from "./source.js";

// Made-up credentials the mock checks for, assembled at runtime so no key-shaped string sits in the repository.
const CLIENT = ["demo", "client", "x".repeat(16)].join("-");
const PASS = ["demo", "pass", "x".repeat(16)].join("-");
const TOKEN = ["access", "sandbox", "x".repeat(16)].join("-");

const balances = (current: number, available: number | null, limit: number | null = null) => ({ available, current, limit, iso_currency_code: "USD", unofficial_currency_code: null });

export const DEMO_ACCOUNTS: PlaidMockAccount[] = [
  { account_id: "acct_demo_operating", name: "Operating Checking", official_name: "Demo Bank Business Checking", mask: "0101", type: "depository", subtype: "checking", balances: balances(386_412.55, 384_090.12) },
  { account_id: "acct_demo_reserve", name: "Tax Reserve Savings", official_name: "Demo Bank Business Savings", mask: "0102", type: "depository", subtype: "savings", balances: balances(142_500, 142_500) },
  { account_id: "acct_demo_card", name: "Business Card", official_name: "Demo Bank Business Card", mask: "0103", type: "credit", subtype: "credit card", balances: balances(18_842.17, 56_157.83, 75_000) },
];

/** Card processor fee taken out before each weekly settlement. */
const CARD_FEE = 0.029;

/** What the card processor paid in for the week ending `daysAgo`: card and financing sales from the seven days before, less fees and returns. */
export function cardSettlement(daysAgo: number): number {
  const cents = DEMO_SALES.filter((s) => s.tender !== "Cash" && s.daysAgo > daysAgo && s.daysAgo <= daysAgo + 7).reduce((sum, s) => sum + (s.returnOf ? -1 : 1) * s.unitCents * s.quantity, 0);
  return Math.round(cents * (1 - CARD_FEE)) / 100;
}

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
    ...[28, 21, 14, 7, 0].map((d) => txn(d, op, -cardSettlement(d), "CARD SETTLEMENT DEMO PAYMENTS")),
    txn(26, op, 4_850, "ACH DEMO REFINING CO", "Demo Refining Co"),
    txn(24, op, 38_600, "WIRE DEMO BRIDAL SUPPLY", "Sample Bridal Supply"),
    txn(12, op, 21_450, "WIRE DEMO LAB DIAMONDS", "Demo Lab Diamonds"),
    txn(6, op, 14_980, "ACH DEMO FINDINGS CO", "Demo Findings Co"),
    txn(15, op, 31_400, "PAYROLL DEMO PAYROLL SVC", "Demo Payroll"),
    txn(1, op, 31_850, "PAYROLL DEMO PAYROLL SVC", "Demo Payroll"),
    txn(10, op, 14_500, "ACH DEMO PROPERTY MGMT RENT", "Demo Property Management"),
    txn(8, op, 2_140, "ACH DEMO JEWELERS INSURANCE", "Demo Jewelers Insurance"),
    txn(18, "acct_demo_card", 1_642.3, "DEMO FINDINGS CO", "Demo Findings Co"),
    txn(9, "acct_demo_card", 3_288, "DEMO PACKAGING SUPPLY", "Demo Packaging"),
    txn(5, "acct_demo_card", 4_120, "DEMO SOCIAL ADS", "Demo Social Ads"),
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
