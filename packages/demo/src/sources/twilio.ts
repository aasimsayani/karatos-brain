import { twilioConnector, type TwilioCall, type TwilioMessage } from "@karatos/connectors";
import type { DemoCalendar } from "../store.js";
import type { DemoSource } from "./source.js";

// Made-up account values, assembled at runtime so no credential-shaped string sits in the repository.
const ACCOUNT = ["AC", "d".repeat(32)].join("");
const KEY_SID = ["SK", "d".repeat(32)].join("");
const PASS = ["demo", "x".repeat(28)].join("");
const CONTACT_KEY = ["demo", "contact", "key", "x".repeat(24)].join("-");
const BASE = `/2010-04-01/Accounts/${ACCOUNT}`;

// 555-0100 to 555-0199 is kept for fiction, so none of these can ring anyone.
const STORE = "+12125550100";
const caller = (n: number) => `+1212555${String(100 + n).padStart(4, "0")}`;
const sid = (prefix: string, n: number) => `${prefix}${n.toString(16).padStart(32, "0")}`;
const rfc2822 = (iso: string) => new Date(iso).toUTCString().replace("GMT", "+0000");

/**
 * A week of the store's phone line. Two people rang without getting
 * through and nobody has called them back; a third was called back the
 * same afternoon, so it no longer counts as missed.
 */
export function demoCalls(calendar: DemoCalendar): TwilioCall[] {
  let n = 0;
  const call = (daysAgo: number, hour: number, from: string, to: string, status: string, direction = "inbound"): TwilioCall => {
    const start = calendar.at(daysAgo, hour);
    const seconds = status === "completed" ? 140 : 0;
    return {
      sid: sid("CA", ++n),
      direction,
      status,
      from,
      to,
      duration: String(seconds),
      price: "-0.0085",
      price_unit: "USD",
      start_time: rfc2822(start),
      end_time: rfc2822(new Date(Date.parse(start) + seconds * 1000).toISOString()),
      date_created: rfc2822(start),
    };
  };
  return [
    call(1, 17, caller(11), STORE, "no-answer"),
    call(1, 18, caller(11), STORE, "busy"),
    call(3, 15, caller(12), STORE, "no-answer"),
    call(4, 14, caller(13), STORE, "no-answer"),
    call(4, 16, STORE, caller(13), "completed", "outbound-dial"),
    call(2, 16, caller(14), STORE, "completed"),
    call(5, 13, caller(15), STORE, "completed"),
  ];
}

export function demoMessages(calendar: DemoCalendar): TwilioMessage[] {
  const message = (n: number, daysAgo: number, inbound: boolean, other: string): TwilioMessage => ({
    sid: sid("SM", n),
    direction: inbound ? "inbound" : "outbound-api",
    status: inbound ? "received" : "delivered",
    from: inbound ? other : STORE,
    to: inbound ? STORE : other,
    num_segments: "1",
    num_media: "0",
    price: "-0.00790",
    price_unit: "USD",
    error_code: null,
    date_sent: rfc2822(calendar.at(daysAgo, 12)),
    date_created: rfc2822(calendar.at(daysAgo, 12)),
  });
  return [message(1, 2, true, caller(16)), message(2, 2, false, caller(16)), message(3, 6, false, caller(17))];
}

/** Twilio's list endpoints, one page each, in the shape its API reference gives. */
export function demoTwilioFetch(calendar: DemoCalendar): typeof globalThis.fetch {
  const lists = { calls: demoCalls(calendar), messages: demoMessages(calendar) };
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    const list = url.pathname.endsWith("/Messages.json") ? "messages" : url.pathname.endsWith("/Calls.json") ? "calls" : null;
    if (!list) return Response.json({ code: 20404, message: "not found", status: 404 }, { status: 404 });
    const path = `${BASE}/${list === "messages" ? "Messages" : "Calls"}.json`;
    return Response.json({ [list]: lists[list], page: 0, page_size: 50, next_page_uri: null, previous_page_uri: null, uri: `${path}?PageSize=50&Page=0` });
  }) as typeof globalThis.fetch;
}

export const twilioSource: DemoSource = {
  integration: "twilio",
  role: "The store's phone line and texts: who called and who still needs a call back",
  connector: (calendar) =>
    twilioConnector({ accountSid: ACCOUNT, apiKeySid: KEY_SID, apiKeySecret: PASS, contactKey: CONTACT_KEY, fetch: demoTwilioFetch(calendar), now: () => calendar.now, sleep: async () => {} }),
};
