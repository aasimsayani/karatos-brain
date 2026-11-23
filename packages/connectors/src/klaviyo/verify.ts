import { checkVerifyLimit, inVerifyPeriod, type VerifyPeriod, type VerifySource, type VerifySourceRecord } from "@karatos/core";
import { KLAVIYO_PAGE_SIZES, type KlaviyoClient } from "./client.js";
import { klaviyoProfileRef } from "./customer.js";
import { klaviyoTime } from "./normalize.js";

/**
 * Klaviyo's own count of the profiles created in a period, from the profiles
 * list the connector already reads (profiles:read). Klaviyo has no count
 * call, so profiles updated since the period began are paged, asking for
 * their times only, and those created in the period are counted. A profile
 * is always updated at or after it was created, so none is missed.
 *
 * Each profile is named by the same keyed reference its synced events
 * carry, so the report never holds a Klaviyo id, email address or phone number.
 */

export async function klaviyoVerify(client: KlaviyoClient, customerKey: string, period: VerifyPeriod): Promise<VerifySource[]> {
  const records: VerifySourceRecord[] = [];
  // greater-than is strict, so start a second early; a profile updated on the boundary is still read.
  const since = new Date(Date.parse(period.from) - 1000).toISOString();
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await client.read("profiles", {
      "fields[profile]": "created,updated",
      filter: `greater-than(updated,${since})`,
      sort: "updated",
      "page[size]": KLAVIYO_PAGE_SIZES.profiles,
      "page[cursor]": cursor,
    });
    for (const profile of page.data) {
      const ref = klaviyoProfileRef(customerKey, profile.id);
      if (!ref || seen.has(ref) || !inVerifyPeriod(klaviyoTime(profile.attributes?.created), period)) continue;
      seen.add(ref);
      records.push({ ref });
    }
    checkVerifyLimit(records, "Klaviyo");
    if (!page.next) break;
    cursor = page.next;
  }
  return [{ subject: "profiles", records, basis: "Klaviyo profiles created in the period" }];
}
