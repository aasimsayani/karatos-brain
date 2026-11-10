import type { Connector, WriteAction } from "@karatos/core";
import { trackingConnector, trackingNumbersFromFile } from "../shipping/tracking.js";
import { FEDEX_TRACKING_NUMBER, fedexClient, type FedexClient, type FedexClientOptions } from "./client.js";
import { fedexPackages } from "./normalize.js";

/**
 * FedEx tracking for the packages on the business's list, such as repairs
 * going to a setter, memo goods and customer deliveries. Each sync reads
 * every number that isn't delivered or returned yet; a package that never
 * moves is dropped 120 days after it was first read. There is nothing to
 * write back.
 */

/** None: shipments are FedEx's to change. */
export const FEDEX_WRITES: WriteAction[] = [];

export interface FedexOptions extends Omit<FedexClientOptions, "now"> {
  trackingNumbers: () => Promise<string[]>;
  /** The most numbers one sync reads. Defaults to 500. */
  maxPerSync?: number;
  /** Numbers per batch; each batch is one checkpoint. Defaults to 25. */
  batchSize?: number;
  /** Days a number that is never delivered or returned keeps being read. Defaults to 120. */
  maxAgeDays?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: FedexClient;
}

/** The tracking numbers in the file FEDEX_TRACKING_NUMBERS_FILE names: one or more a line, `#` lines left out. */
export function fedexTrackingNumbersFromFile(path: string, read?: (path: string) => Promise<string>): () => Promise<string[]> {
  return trackingNumbersFromFile(path, FEDEX_TRACKING_NUMBER, read);
}

export function fedexConnector(options: FedexOptions): Connector {
  const now = options.now ?? (() => new Date());
  const client = options.client ?? fedexClient({ ...options, now });
  return trackingConnector({
    carrier: "fedex",
    pattern: FEDEX_TRACKING_NUMBER,
    trackingNumbers: options.trackingNumbers,
    maxPerSync: options.maxPerSync ?? 500,
    batchSize: options.batchSize ?? 25,
    maxAgeDays: options.maxAgeDays ?? 120,
    writes: FEDEX_WRITES,
    now,
    client: {
      async track(number) {
        const result = await client.track(number);
        return result.kind === "not_found" ? result : { kind: "found", packages: fedexPackages(result.results) };
      },
    },
  });
}
