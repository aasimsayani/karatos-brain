import { describe, expect, it } from "vitest";
import type { Connector, SourceBatch } from "@karatos/core";
import { INTEGRATIONS } from "@karatos/core";
import {
  DocMockDefinitionError,
  UndocumentedRequestError,
  allDocMocks,
  assertSynthetic,
  checkConnectorSync,
  checkDocMock,
  docMockFetch,
  docMockVendorDocsTargets,
  docMockWatchTargets,
  stullerDocMock,
  stullerInvoice,
  type DocMock,
  type StullerInvoice,
} from "../src/index.js";

const BASIC = { authorization: `Basic ${Buffer.from("dev-login-test:not-a-password").toString("base64")}` };

function exampleMock(overrides: Partial<DocMock> = {}): DocMock {
  return {
    integration: "example_vendor",
    baseUrl: "https://api.vendor.example/v1/",
    source: { url: "https://docs.vendor.example/api", title: "Example API", retrievedOn: "2026-10-15" },
    auth: "bearer",
    assumptions: [],
    routes: [
      {
        method: "GET",
        path: "/items/{id}",
        documentedAt: "https://docs.vendor.example/api/items",
        respond: (_req, params) => ({ status: 200, body: { id: params.id } }),
      },
      {
        method: "POST",
        path: "/search",
        documentedAt: "https://docs.vendor.example/api/search",
        respond: (req) => ({ status: 201, body: { echo: JSON.parse(req.body) }, headers: { "x-request-id": "req-test-1" } }),
      },
      {
        method: "DELETE",
        path: "/items/{id}",
        documentedAt: "https://docs.vendor.example/api/items",
        respond: () => ({ status: 204, body: undefined }),
      },
    ],
    ...overrides,
  };
}

describe("checkDocMock", () => {
  it("accepts a mock that says where it came from", () => {
    expect(checkDocMock(exampleMock()).integration).toBe("example_vendor");
  });

  it("lists every problem with an incomplete mock", () => {
    const route = exampleMock().routes[0]!;
    const bad = exampleMock({
      integration: "Example Vendor",
      baseUrl: "http://api.vendor.example",
      source: { url: "not a url", title: " ", retrievedOn: "2026-02-30" },
      routes: [route, { ...route, path: "/ITEMS/{id}" }, { ...route, method: "PUT", path: "items", documentedAt: "http://docs" }],
    });
    try {
      checkDocMock(bad);
      throw new Error("expected a DocMockDefinitionError");
    } catch (error) {
      expect(error).toBeInstanceOf(DocMockDefinitionError);
      expect((error as DocMockDefinitionError).problems).toEqual([
        "integration must be a catalog id",
        "baseUrl must be https",
        "source.url must be https",
        "source.title is empty",
        "source.retrievedOn must be a YYYY-MM-DD date",
        "GET /items/{id} is defined twice",
        "PUT items must start with /",
        "PUT items needs an https documentedAt page",
      ]);
    }
    expect(() => checkDocMock(exampleMock({ routes: [] }))).toThrow("no routes");
    expect(() => checkDocMock(exampleMock({ source: { url: "https://d.example", title: "t", retrievedOn: "15/10/2026" } }))).toThrow("retrievedOn");
  });
});

describe("docMockFetch", () => {
  const bearer = { authorization: "Bearer token-test" };

  it("answers documented routes with path parameters, under the base path", async () => {
    const fetch = docMockFetch(exampleMock());
    const res = await fetch("https://api.vendor.example/v1/items/SKU%20TEST%201", { headers: bearer });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ id: "SKU TEST 1" });
    expect(fetch.calls).toEqual([{ method: "GET", url: "https://api.vendor.example/v1/items/SKU%20TEST%201" }]);
  });

  it("passes the request body and response headers through, and accepts Request objects", async () => {
    const fetch = docMockFetch(exampleMock());
    const res = await fetch(new Request("https://api.vendor.example/v1/search", { method: "post", headers: bearer, body: '{"q":"ring"}' }));
    expect(res.status).toBe(201);
    expect(res.headers.get("x-request-id")).toBe("req-test-1");
    expect(await res.json()).toEqual({ echo: { q: "ring" } });
    const gone = await fetch(new URL("https://api.vendor.example/v1/items/1"), { method: "DELETE", headers: bearer });
    expect(gone.status).toBe(204);
    expect(await gone.text()).toBe("");
  });

  it("refuses anything the docs don't list", async () => {
    const fetch = docMockFetch(exampleMock());
    for (const [url, method] of [
      ["https://api.vendor.example/v1/orders", "GET"],
      ["https://api.vendor.example/v1/items/1", "PATCH"],
      ["https://api.vendor.example/v1/items/", "GET"],
      ["https://api.vendor.example/v1/items/1/extra", "GET"],
      ["https://api.vendor.example/v2/items/1", "GET"],
      ["https://evil.example/v1/items/1", "GET"],
    ] as const) {
      await expect(fetch(url, { method, headers: bearer })).rejects.toBeInstanceOf(UndocumentedRequestError);
    }
    await expect(fetch("https://api.vendor.example/v1/orders")).rejects.toThrow("GET https://api.vendor.example/v1/orders is not in the vendor's docs");
    expect(fetch.calls).toEqual([]);
  });

  it("answers 401 like the vendor when the documented auth is missing", async () => {
    const bearerMock = docMockFetch(exampleMock());
    expect((await bearerMock("https://api.vendor.example/v1/items/1")).status).toBe(401);
    expect((await bearerMock("https://api.vendor.example/v1/items/1", { headers: { authorization: "Basic abc=" } })).status).toBe(401);
    const basicMock = docMockFetch(exampleMock({ auth: "basic" }));
    expect((await basicMock("https://api.vendor.example/v1/items/1", { headers: bearer })).status).toBe(401);
    expect((await basicMock("https://api.vendor.example/v1/items/1", { headers: BASIC })).status).toBe(200);
    const { auth: _none, ...withoutAuth } = exampleMock();
    expect((await docMockFetch(withoutAuth)("https://api.vendor.example/v1/items/1")).status).toBe(200);
  });

  it("works with a base URL at the host root", async () => {
    const fetch = docMockFetch(exampleMock({ baseUrl: "https://api.vendor.example" }));
    expect((await fetch("https://api.vendor.example/items/7", { headers: { authorization: "Bearer t" } })).status).toBe(200);
  });
});

describe("docMockWatchTargets", () => {
  it("lists each doc page once, with a stable id and the day it was read", () => {
    const targets = docMockWatchTargets([exampleMock(), exampleMock()]);
    expect(targets).toEqual([
      { id: "example_vendor:docs-vendor-example-api", integration: "example_vendor", url: "https://docs.vendor.example/api", retrievedOn: "2026-10-15" },
      { id: "example_vendor:docs-vendor-example-api-items", integration: "example_vendor", url: "https://docs.vendor.example/api/items", retrievedOn: "2026-10-15" },
      { id: "example_vendor:docs-vendor-example-api-search", integration: "example_vendor", url: "https://docs.vendor.example/api/search", retrievedOn: "2026-10-15" },
    ]);
  });

  it("covers every page the built-in mocks came from", () => {
    expect(docMockWatchTargets(allDocMocks()).map((t) => t.url)).toEqual([
      "https://api.stuller.com/help",
      "https://api.stuller.com/Help/Api/GET-namespace-v2.Invoice-Rest",
      "https://api.stuller.com/Help/Api/GET-namespace-v2.Products-MetalMarketRates",
      "https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0",
      "https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/account",
      "https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/data-queries",
      "https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/changedatacapture",
      "https://developer.authorize.net/api/reference/index.html",
      "https://developer.authorize.net/api/reference/features/transaction-reporting.html",
    ]);
  });
});

describe("built-in doc mocks", () => {
  it("each stands in for a catalog system we can't reach on our own yet, and lists its assumptions", () => {
    for (const mock of allDocMocks()) {
      const spec = INTEGRATIONS.find((i) => i.id === mock.integration);
      expect(spec, mock.integration).toBeDefined();
      // A free sandbox counts until an account is set up for it; its recordings then replace the mock.
      expect(["paid_account", "partner", "sandbox"]).toContain(spec!.testWith);
      expect(mock.source.version ?? "", mock.integration).not.toBe("");
      expect(mock.assumptions.length, mock.integration).toBeGreaterThan(0);
    }
  });
});

describe("Stuller doc mock", () => {
  const invoices = stullerInvoice.many(3);
  const mock = () => docMockFetch(stullerDocMock({ invoices, metalRates: [{ Type: "Gold", Rate: 2742.1 }, { Type: "Silver", Rate: 32.18 }] }));

  it("uses only synthetic data", () => {
    expect(() => assertSynthetic(invoices)).not.toThrow();
  });

  it("returns invoices in the documented shape, filtered by PO or invoice number", async () => {
    const fetch = mock();
    const all = (await (await fetch("https://api.stuller.com/api/v2/invoice", { headers: BASIC })).json()) as { Invoices: StullerInvoice[] };
    expect(all.Invoices).toHaveLength(3);
    expect(Object.keys(all.Invoices[0]!)).toContain("InvoiceDetails");
    expect(Object.keys(all.Invoices[0]!.InvoiceDetails[0]!)).toEqual([
      "LineNumber", "CustomerLineReference", "ItemNumber", "ItemDescription", "ShipQuantity", "BackOrderedQuantity",
      "LaborOtherCharges", "TotalWeight", "UnitPrice", "LineTotal", "CustomerNotes", "UnitPriceUnitOfMeasure",
    ]);
    const byPo = await fetch(`https://api.stuller.com/api/v2/invoice?PurchaseOrderNumber=${invoices[0]!.PurchaseOrderNumber}&PurchaseOrderNumber=${invoices[2]!.PurchaseOrderNumber}`, { headers: BASIC });
    expect(((await byPo.json()) as { Invoices: StullerInvoice[] }).Invoices.map((i) => i.InvoiceNumber)).toEqual([invoices[0]!.InvoiceNumber, invoices[2]!.InvoiceNumber]);
    const both = await fetch(`https://api.stuller.com/api/v2/invoice?PurchaseOrderNumber=${invoices[0]!.PurchaseOrderNumber}&InvoiceNumber=${invoices[1]!.InvoiceNumber}`, { headers: BASIC });
    expect(((await both.json()) as { Invoices: StullerInvoice[] }).Invoices).toEqual([]);
    const comma = await fetch(`https://api.stuller.com/api/v2/invoice?InvoiceNumber=${invoices[1]!.InvoiceNumber},${invoices[2]!.InvoiceNumber}`, { headers: BASIC });
    expect(((await comma.json()) as { Invoices: StullerInvoice[] }).Invoices).toHaveLength(2);
  });

  it("returns metal market rates and needs a developer login", async () => {
    const fetch = mock();
    expect(await (await fetch("https://api.stuller.com/api/v2/products/metalmarketrates", { headers: BASIC })).json()).toEqual({
      MetalMarkets: [{ Type: "Gold", Rate: 2742.1 }, { Type: "Silver", Rate: 32.18 }],
    });
    expect((await fetch("https://api.stuller.com/api/v2/invoice")).status).toBe(401);
    await expect(fetch("https://api.stuller.com/api/v2/orders", { headers: BASIC })).rejects.toBeInstanceOf(UndocumentedRequestError);
  });

  it("lets a connector be written and sync-tested before we have an account", async () => {
    function stullerInvoices(fetch: typeof globalThis.fetch): Connector {
      async function* all(): AsyncIterable<SourceBatch> {
        const res = await fetch("https://api.stuller.com/api/v2/invoice", { headers: BASIC });
        if (!res.ok) throw new Error(`stuller answered ${res.status}`);
        const body = (await res.json()) as { Invoices: StullerInvoice[] };
        yield {
          cursor: "done",
          events: body.Invoices.map((i) => ({
            id: `stuller_invoice_${i.InvoiceNumber}`,
            type: "supplier.invoice_received",
            occurredAt: i.InvoiceDate,
            receivedAt: "2026-10-15T00:00:00.000Z",
            idempotencyKey: `stuller-invoice-${i.InvoiceNumber}`,
            payload: { invoiceNumber: i.InvoiceNumber, total: i.InvoiceTotal, lines: i.InvoiceDetails.length },
          })),
        };
      }
      return { source: "stuller", historicalImport: all, incrementalSync: all, writes: [] };
    }
    const result = await checkConnectorSync({ makeConnector: () => stullerInvoices(mock()), expected: { ingested: 3 } });
    expect(result.full.ingested).toBe(3);
  });
});

describe("docMockVendorDocsTargets", () => {
  it("gives each mock page its own watch key, named after the catalog entry", () => {
    const targets = docMockVendorDocsTargets(allDocMocks());
    expect(targets).toHaveLength(9);
    expect(targets[0]).toEqual({
      integration: "stuller:api-stuller-com-help",
      name: "Stuller",
      url: "https://api.stuller.com/help",
      mock: { integration: "stuller", retrievedOn: "2026-10-15" },
    });
    expect(new Set(targets.map((t) => t.integration)).size).toBe(9);
  });

  it("falls back to the integration id for a mock outside the catalog", () => {
    expect(docMockVendorDocsTargets([exampleMock()])[0]!.name).toBe("example_vendor");
  });
});
