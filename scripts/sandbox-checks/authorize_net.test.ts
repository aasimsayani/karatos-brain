import { describe, expect, it, vi } from "vitest";
import authorizeNet from "./authorize_net.js";

describe("the Authorize.net sandbox check", () => {
  it("builds the Authorize.net connector against the sandbox endpoint only, sending reporting requests with the sandbox key", async () => {
    expect(authorizeNet.credentials).toEqual(["SANDBOX_AUTHORIZE_NET_API_LOGIN_ID", "SANDBOX_AUTHORIZE_NET_TRANSACTION_KEY"]);
    // Shaped like a Transaction Key, assembled so no scanner mistakes it for one.
    const key = ["TEST", "0".repeat(12)].join("");
    const sent: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(`﻿${JSON.stringify({ messages: { resultCode: "Error", message: [{ code: "E00007", text: "stop" }] } })}`, { status: 200 });
    });
    try {
      const connector = authorizeNet.connector({ SANDBOX_AUTHORIZE_NET_API_LOGIN_ID: "testlogin0", SANDBOX_AUTHORIZE_NET_TRANSACTION_KEY: key });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "E00007" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => s.url)).toEqual(["https://apitest.authorize.net/xml/v1/request.api"]);
    expect(JSON.parse(sent[0]!.body)).toEqual({ getMerchantDetailsRequest: { merchantAuthentication: { name: "testlogin0", transactionKey: key } } });
  });
});
