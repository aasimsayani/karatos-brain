import { gustoConnector, memoryTokenStore } from "@karatos/connectors";
import { gustoDocMock, gustoUuid, GUSTO_TEST_COMPANY, type GustoEmployeeCompensation, type GustoPayroll } from "@karatos/connector-testkit";
import type { DemoCalendar } from "../store.js";
import type { DemoSource } from "./source.js";

// Made-up app credentials, assembled at runtime so no key-shaped string sits in the repository.
const CLIENT = ["demo", "x".repeat(40)].join("-");
const PASS = ["demo", "pass", "x".repeat(36)].join("-");
const REFRESH = ["RT", "DEMO", "0"].join("-");

const money = (dollars: number) => dollars.toFixed(2);

/** The store's staff on the regular payroll. Names are invented. */
const STAFF = ["Associate One", "Associate Two", "Associate Three", "Associate Four", "Associate Five", "Bench Jeweler", "Store Manager", "Office Manager"];

/** Gross pay of each regular payroll, oldest first. The last one, paid yesterday, has holiday overtime and a bonus nobody flagged. */
export const DEMO_PAYROLL_GROSS = [28_900, 29_400, 28_600, 29_100, 41_850];

function payroll(n: number, checkDaysAgo: number, gross: number, calendar: DemoCalendar): GustoPayroll {
  const per = gross / STAFF.length;
  const comps: GustoEmployeeCompensation[] = STAFF.map((name, i) => {
    const [first, last] = name.split(" ") as [string, string];
    const pay = Math.round(per * 100) / 100;
    return {
      employee_uuid: gustoUuid("e", i + 1),
      first_name: first,
      last_name: last,
      excluded: false,
      gross_pay: money(pay),
      net_pay: money(pay * 0.76),
      check_amount: money(pay * 0.76),
      payment_method: "Direct Deposit",
      fixed_compensations: [{ name: "Commission", amount: "0.00", job_uuid: gustoUuid("j", i + 1) }],
      hourly_compensations: [{ name: "Regular Hours", hours: "80.000", amount: money(pay), compensation_multiplier: 1, job_uuid: gustoUuid("j", i + 1) }],
      paid_time_off: [],
    };
  });
  const employerTaxes = gross * 0.0765;
  return {
    uuid: gustoUuid("p", n),
    payroll_uuid: gustoUuid("p", n),
    company_uuid: GUSTO_TEST_COMPANY,
    processed: true,
    processed_date: calendar.date(checkDaysAgo + 2),
    check_date: calendar.date(checkDaysAgo),
    off_cycle: false,
    off_cycle_reason: null,
    external: false,
    payroll_deadline: `${calendar.date(checkDaysAgo + 2)}T23:00:00Z`,
    pay_period: { start_date: calendar.date(checkDaysAgo + 17), end_date: calendar.date(checkDaysAgo + 4), pay_schedule_uuid: gustoUuid("5c", 1) },
    totals: {
      company_debit: money(gross + employerTaxes),
      net_pay_debit: money(gross * 0.76),
      tax_debit: money(gross * 0.24 + employerTaxes),
      reimbursement_debit: "0.00",
      gross_pay: money(gross),
      net_pay: money(gross * 0.76),
      employer_taxes: money(employerTaxes),
      employee_taxes: money(gross * 0.24),
      benefits: "0.00",
      reimbursements: "0.00",
      employee_bonuses: "0.00",
      employee_commissions: "0.00",
      check_amount: money(gross * 0.76),
    },
    employee_compensations: comps,
  };
}

/** Every two weeks, the last one yesterday. */
export function demoPayrolls(calendar: DemoCalendar): GustoPayroll[] {
  return DEMO_PAYROLL_GROSS.map((gross, i) => payroll(i + 1, 1 + (DEMO_PAYROLL_GROSS.length - 1 - i) * 14, gross, calendar));
}

export const gustoSource: DemoSource = {
  integration: "gusto",
  role: "Payroll: each pay run's gross pay, taxes and what the bank was debited",
  connector: (calendar) => {
    const mock = gustoDocMock({ payrolls: demoPayrolls(calendar), refreshToken: REFRESH });
    return gustoConnector({
      clientId: CLIENT,
      clientSecret: PASS,
      redirectUri: "https://brain.example.test/oauth/gusto",
      companyUuid: GUSTO_TEST_COMPANY,
      environment: "demo",
      tokens: memoryTokenStore(REFRESH),
      fetch: mock.fetch,
      sleep: async () => {},
      now: () => calendar.now,
    });
  },
};
