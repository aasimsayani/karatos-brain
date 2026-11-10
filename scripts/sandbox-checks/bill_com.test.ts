import { describe, expect, it, vi } from "vitest";
import bill from "./bill_com.js";

describe("the BILL sandbox check", () => {
  it("signs in at BILL's sandbox only, with the sandbox app's id and secret", async () => {
    expect(bill.credentials).toEqual(["SANDBOX_BILL_COM_CLIENT_ID", "SANDBOX_BILL_COM_CLIENT_SECRET"]);
    // Shaped like a BILL client id and secret, assembled so no scanner mistakes them for real ones.
    const id = ["test", "0".repeat(20)].join("");
    const secret = ["test", "1".repeat(28)].join("");
    const sent: { url: string; method: string; type: string | null; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "", type: new Headers(init?.headers).get("content-type"), body: String(init?.body) });
      return new Response(JSON.stringify({ message: "Invalid client" }), { status: 401 });
    });
    try {
      const connector = bill.connector({ SANDBOX_BILL_COM_CLIENT_ID: id, SANDBOX_BILL_COM_CLIENT_SECRET: secret });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toMatchObject({ status: 401 });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toHaveLength(1);
    expect([sent[0]!.method, sent[0]!.url, sent[0]!.type]).toEqual(["POST", "https://auth.stage.bill.com/authx/token", "application/x-www-form-urlencoded"]);
    expect(Object.fromEntries(new URLSearchParams(sent[0]!.body))).toEqual({ grant_type: "client_credentials", client_id: id, client_secret: secret });
  });
});
