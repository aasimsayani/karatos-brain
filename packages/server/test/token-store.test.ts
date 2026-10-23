import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryStore } from "@karatos/core";
import { REFRESH_TOKEN_STREAM, sealedTokenStore } from "../src/index.js";

const ORG = "test-jeweler";
// Test-only values, assembled at runtime.
const SECRET = ["client", "secret", "0".repeat(20)].join("-");
const SEED = ["RT", "TEST", "0"].join("-");
const store = (memory = new InMemoryStore(), overrides: Partial<Parameters<typeof sealedTokenStore>[0]> = {}) =>
  sealedTokenStore({ memory, organizationId: ORG, source: "quickbooks", seed: SEED, keyMaterial: SECRET, ...overrides });
const sealed = (memory: InMemoryStore) => memory.getCheckpoint(ORG, "quickbooks", REFRESH_TOKEN_STREAM);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sealedTokenStore", () => {
  it("starts from the seed, then returns the newest saved token, kept encrypted", async () => {
    const memory = new InMemoryStore();
    const tokens = store(memory);
    expect(await tokens.load()).toBe(SEED);
    await tokens.save("RT-TEST-41");
    expect(await tokens.load()).toBe("RT-TEST-41");
    expect(await store(memory).load()).toBe("RT-TEST-41");
    const raw = (await sealed(memory))!;
    expect(raw).not.toContain("RT-TEST-41");
    expect(raw).not.toContain(SEED);
    expect(Object.keys(JSON.parse(raw))).toEqual(["v", "seed", "iv", "tag", "data"]);
    // A fresh IV every time: sealing the same token twice gives different rows.
    await tokens.save("RT-TEST-41");
    expect(await sealed(memory)).not.toBe(raw);
  });

  it("goes back to the seed when it is replaced, the client secret rotates, or the row is tampered with", async () => {
    const memory = new InMemoryStore();
    await store(memory).save("RT-TEST-41");
    expect(await store(memory, { seed: "RT-TEST-NEW" }).load()).toBe("RT-TEST-NEW");
    expect(await store(memory, { keyMaterial: `${SECRET}x` }).load()).toBe(SEED);
    expect(await store(memory, { organizationId: "other-store" }).load()).toBe(SEED);
    const row = JSON.parse((await sealed(memory))!) as { data: string };
    const flipped = Buffer.from(row.data, "base64");
    flipped[0] = flipped[0]! ^ 1;
    await memory.saveCheckpoint(ORG, "quickbooks", REFRESH_TOKEN_STREAM, JSON.stringify({ ...row, data: flipped.toString("base64") }));
    expect(await store(memory).load()).toBe(SEED);
    for (const junk of ["not json", JSON.stringify({ v: 2 }), "null"]) {
      await memory.saveCheckpoint(ORG, "quickbooks", REFRESH_TOKEN_STREAM, junk);
      expect(await store(memory).load()).toBe(SEED);
    }
  });

  it("needs a seed and enough key material, and ignores an empty token", async () => {
    expect(() => store(undefined, { seed: " " })).toThrow("a refresh token store needs a seed token");
    expect(() => store(undefined, { keyMaterial: "short" })).toThrow("a refresh token store needs the client secret to derive its key");
    const memory = new InMemoryStore();
    await store(memory).save("  ");
    expect(await sealed(memory)).toBeNull();
  });
});
