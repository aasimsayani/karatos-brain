import { memoryFileSource, watchSearchConnector } from "@karatos/connectors";
import type { DemoCalendar } from "../store.js";
import type { DemoSource } from "./source.js";

// Assembled at runtime so no key-shaped string sits in the repository.
const DEALER_KEY = ["demo", "dealer", "key", "x".repeat(24)].join("-");

/**
 * Two exported WhatsApp dealer groups. Three dealers in the last week have
 * asked for the same Rolex reference, which the dashboard should notice.
 * Every name is a placeholder.
 */
export function demoChats(calendar: DemoCalendar): Record<string, string> {
  // Android exports write month-first dates with two-digit years.
  const stamp = (daysAgo: number, time: string) => {
    const [y, m, d] = calendar.date(daysAgo).split("-");
    return `${Number(m)}/${Number(d)}/${y!.slice(2)}, ${time}`;
  };
  const north = [
    `${stamp(9, "9:00 AM")} - Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.`,
    `${stamp(9, "9:02 AM")} - Sample Dealer 1: WTS`,
    "Rolex 126610LN 2023 full set $14,900",
    "Omega 310.30.42.50.01.001 new $6,450",
    `${stamp(6, "11:15 AM")} - Sample Dealer 2: LF Rolex 126500LN any dial, full set`,
    `${stamp(5, "4:40 PM")} - Sample Dealer 3: Looking for Rolex 126500LN white, will pay strong`,
    `${stamp(2, "10:05 AM")} - Sample Dealer 1: Good morning all`,
  ].join("\n");
  const south = [
    `${stamp(8, "2:03 PM")} - Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.`,
    `${stamp(7, "2:04 PM")} - Sample Dealer 4: Available today`,
    "Rolex 126500LN 2024 black dial B&P $29,500",
    "Cartier WSSA0018 pre-owned watch only 5,900 USD",
    `${stamp(3, "9:20 AM")} - Sample Dealer 5: WTB Rolex 126500LN unworn`,
    `${stamp(1, "3:30 PM")} - Sample Dealer 6: Tudor M79360N-0001 wanted`,
  ].join("\n");
  return { "WhatsApp Chat - Demo Dealers North.txt": north, "WhatsApp Chat - Demo Dealers South.txt": south };
}

export const watchSearchSource: DemoSource = {
  integration: "watchsearch",
  role: "Pre-owned watch dealer groups: what dealers want and what they're asking",
  connector: (calendar) => watchSearchConnector({ source: memoryFileSource(demoChats(calendar), calendar.at(0, 6)), dealerKey: DEALER_KEY, dateOrder: "mdy", now: () => calendar.now }),
};
