import { describe, expect, it, vi } from "vitest";
import sola from "./sola_payments.js";

describe("the Sola Payments sandbox check", () => {
  it("builds the Sola connector with the sandbox key, posting only Report:All to the reporting address", async () => {
    expect(sola.credentials).toEqual(["SANDBOX_SOLA_PAYMENTS_API_KEY"]);
    // Shaped like a Sola key, assembled so no scanner mistakes it for a real one.
    const key = ["sandbox", "0".repeat(24)].join("_");
    const sent: { url: string; method: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "", body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ xResult: "E", xError: "Invalid xKey", xErrorCode: "00001" }), { status: 200 });
    });
    try {
      const connector = sola.connector({ SANDBOX_SOLA_PAYMENTS_API_KEY: key });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("Sola turned down SOLA_API_KEY (code 00001)");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(["POST https://x1.cardknox.com/reportjson"]);
    expect(sent[0]!.body).toMatchObject({ xKey: key, xCommand: "Report:All" });
  });
});
