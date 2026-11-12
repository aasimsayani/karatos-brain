import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrainPipeline, InMemoryStore } from "@karatos/core";

// Watches every constant-time comparison the app makes, still comparing for real.
const compared = vi.hoisted(() => ({ calls: [] as [number, number][] }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      compared.calls.push([a.byteLength, b.byteLength]);
      return actual.timingSafeEqual(a, b);
    },
  };
});

const { randomBytes } = await import("node:crypto");
const { createBrainApp, StaticDocumentationSource } = await import("../src/index.js");

// Built at runtime so no key-shaped literal sits in the repository.
const INSTANCE_KEY = `i${randomBytes(32).toString("hex")}`;
const SUPPORT_KEY = `s${randomBytes(20).toString("hex")}`;

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));
beforeEach(() => {
  compared.calls = [];
});

async function start(withSupport: boolean) {
  const memory = new InMemoryStore();
  const pipeline = new BrainPipeline({ memory, normalizers: [], extractors: [], reasoners: [], documentation: new StaticDocumentationSource([]) });
  server = createServer(createBrainApp({ pipeline, memory, organizationId: "example-jewelers", apiKey: INSTANCE_KEY, ...(withSupport ? { supportApiKey: SUPPORT_KEY } : {}) }));
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return (path: string, key: string) => fetch(base + path, { headers: { authorization: `Bearer ${key}` } });
}

describe("support key comparison", () => {
  it("compares both keys in constant time on every request, whichever key was sent, over fixed-width buffers", async () => {
    const call = await start(true);
    const cases: [key: string, path: string, status: number][] = [
      [INSTANCE_KEY, "/v1/recommendations", 200],
      [SUPPORT_KEY, "/v1/integrations", 200],
      [SUPPORT_KEY, "/v1/recommendations", 403],
      [`x${randomBytes(8).toString("hex")}`, "/v1/integrations", 401],
      [SUPPORT_KEY.slice(0, -1), "/v1/integrations", 401],
    ];
    for (const [key, path, status] of cases) {
      compared.calls = [];
      expect((await call(path, key)).status).toBe(status);
      // Two comparisons, the instance key's and the support key's, each 512 bytes wide whatever the key lengths.
      expect(compared.calls, `${path} → ${status}`).toEqual([
        [512, 512],
        [512, 512],
      ]);
    }
  });

  it("compares once when no support key is set", async () => {
    const call = await start(false);
    expect((await call("/v1/integrations", SUPPORT_KEY)).status).toBe(401);
    expect(compared.calls).toEqual([[512, 512]]);
  });

  it("never compares a token longer than 512 bytes", async () => {
    const call = await start(true);
    expect((await call("/v1/integrations", "s".repeat(513))).status).toBe(401);
    expect(compared.calls).toEqual([]);
  });
});
