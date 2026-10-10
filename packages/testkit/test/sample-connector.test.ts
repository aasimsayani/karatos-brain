import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runSync } from "@karatos/core";
import {
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  fixtureBuilder,
  hmacSha256,
  loadRecordings,
  replayFetch,
  synthetic,
  tamper,
  testPipeline,
} from "../src/index.js";
import { demoShopConnector, verifyDemoShopWebhook, type DemoShopOrder } from "./demo-shop.js";

const RECORDINGS = fileURLToPath(new URL("./recordings/demo-shop-orders.json", import.meta.url));
const recordings = await loadRecordings(RECORDINGS);

const orders = fixtureBuilder<DemoShopOrder>((n) => ({
  id: `900${n}`,
  name: `#900${n}`,
  email: synthetic.email(n),
  total: "125.00",
  currency: "USD",
  created_at: synthetic.isoTime(n),
  updated_at: synthetic.isoTime(n + 1),
}));

describe("sample connector built with the kit", () => {
  it("ships recordings that hold only synthetic data", () => {
    assertSynthetic(recordings);
  });

  it("survives every runSync scenario against recorded responses", async () => {
    const result = await checkConnectorSync({
      makeConnector: () => demoShopConnector(replayFetch(recordings, { reuse: true })),
      expected: { ingested: 4, deadLettered: 1 },
    });
    expect(result.full.batches).toBe(3);
    expect(result.replay.duplicates).toBe(4);
    expect(result.resume?.ingested).toBeLessThan(4);
  });

  it("makes exactly the recorded requests, in order", async () => {
    const fetch = replayFetch(recordings);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: demoShopConnector(fetch), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(fetch.calls.map((c) => new URL(c.url).searchParams.get("page_info"))).toEqual([null, "p2", "p3"]);
    expect(fetch.unused()).toEqual([]);
  });

  it("retries a rate-limited page", async () => {
    const limited = { request: recordings[0]!.request, response: { status: 429, body: { error: "slow down" } } };
    const fetch = replayFetch([limited, ...recordings]);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({
      connector: demoShopConnector(fetch),
      mode: "historical",
      pipeline,
      memory,
      organizationId: TEST_ORG,
      sleep: async () => {},
    });
    expect(report.ingested).toBe(4);
    expect(fetch.unused()).toEqual([]);
  });

  it("accepts signed webhooks and rejects tampered or unsigned ones", () => {
    const secret = "test-webhook-secret";
    const body = JSON.stringify(orders.one());
    const signature = hmacSha256(secret, body, "base64");
    expect(verifyDemoShopWebhook(secret, body, signature)).toBe(true);
    expect(verifyDemoShopWebhook(secret, tamper(body), signature)).toBe(false);
    expect(verifyDemoShopWebhook("another_secret", body, signature)).toBe(false);
    expect(verifyDemoShopWebhook(secret, body, undefined)).toBe(false);
    const events = demoShopConnector(replayFetch([])).handleWebhook!(JSON.parse(body));
    expect(events).toHaveLength(1);
    assertSynthetic(events);
  });

  it("declares its writes and a read-only gate refuses every one", async () => {
    const audit = await assertWritesRefused(demoShopConnector(replayFetch([])));
    expect(audit.map((e) => [e.action, e.outcome])).toEqual([["tag_order", "refused"]]);
  });
});
