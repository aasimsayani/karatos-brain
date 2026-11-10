import type { Connector, WriteAction } from "@karatos/core";
import { trackingConnector, trackingNumbersFromFile } from "../shipping/tracking.js";
import { UPS_TRACKING_NUMBER, upsClient, type UpsClient, type UpsClientOptions } from "./client.js";
import { upsPackages } from "./normalize.js";

/**
 * UPS tracking for the packages on the business's list, such as repairs
 * going to a setter, memo goods and customer deliveries. Each sync reads
 * every number that isn't delivered or returned yet; a package that never
 * moves is dropped 120 days after it was first read. There is nothing to
 * write back.
 */

/** None: shipments are UPS's to change. */
export const UPS_WRITES: WriteAction[] = [];

export interface UpsOptions extends Omit<UpsClientOptions, "now"> {
  /** The tracking numbers to read. */
  trackingNumbers: () => Promise<string[]>;
  /** The most numbers one sync reads. Defaults to 500. */
  maxPerSync?: number;
  /** Numbers per batch; each batch is one checkpoint. Defaults to 25. */
  batchSize?: number;
  /** Days a number that is never delivered or returned keeps being read. Defaults to 120. */
  maxAgeDays?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: UpsClient;
}

/** The tracking numbers in the file UPS_TRACKING_NUMBERS_FILE names: one or more a line, `#` lines left out. */
export function upsTrackingNumbersFromFile(path: string, read?: (path: string) => Promise<string>): () => Promise<string[]> {
  return trackingNumbersFromFile(path, UPS_TRACKING_NUMBER, read);
}

export function upsConnector(options: UpsOptions): Connector {
  const now = options.now ?? (() => new Date());
  const client = options.client ?? upsClient({ ...options, now });
  return trackingConnector({
    carrier: "ups",
    pattern: UPS_TRACKING_NUMBER,
    trackingNumbers: options.trackingNumbers,
    maxPerSync: options.maxPerSync ?? 500,
    batchSize: options.batchSize ?? 25,
    maxAgeDays: options.maxAgeDays ?? 120,
    writes: UPS_WRITES,
    now,
    client: {
      async track(number) {
        const result = await client.track(number);
        return result.kind === "not_found" ? result : { kind: "found", packages: upsPackages(result.body) };
      },
    },
  });
}
