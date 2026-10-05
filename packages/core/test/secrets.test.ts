import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConfigSchema, generateSecret, parseManifest, planSecrets, redact, type SecretsManifest } from "../src/index.js";

const manifestPath = new URL("../../../secrets/manifest.json", import.meta.url);
const realManifest = () => parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")));

const manifest: SecretsManifest = {
  version: 1,
  entries: [
    { name: "ORG", kind: "config", description: "org", requiredFor: ["core"], pattern: "[a-z-]+", howToGet: ["pick one"] },
    {
      name: "API_KEY",
      kind: "secret",
      description: "key",
      requiredFor: ["instance"],
      generate: { method: "random_hex", bytes: 32 },
      howToGet: ["generated"],
    },
    { name: "SHOP_TOKEN", kind: "secret", description: "shop", requiredFor: ["integration:shop"], howToGet: ["shop admin"] },
  ],
};

describe("planSecrets", () => {
  it("lists what is missing and what will be generated", () => {
    const plan = planSecrets(manifest, {}, { purposes: ["core", "instance"], integrations: [] });
    expect(plan.ready).toBe(false);
    expect(plan.items.map((i) => [i.name, i.status])).toEqual([
      ["ORG", "missing"],
      ["API_KEY", "will_generate"],
      ["SHOP_TOKEN", "not_needed"],
    ]);
  });

  it("only requires integration secrets once the integration is enabled", () => {
    const plan = planSecrets(manifest, { ORG: "fuse" }, { purposes: ["core"], integrations: ["shop"] });
    expect(plan.items.find((i) => i.name === "SHOP_TOKEN")?.status).toBe("missing");
  });

  it("never blocks on optional entries", () => {
    const optional: SecretsManifest = {
      version: 1,
      entries: [{ name: "DOCS", kind: "config", description: "d", requiredFor: ["instance"], optional: true, howToGet: ["x"] }],
    };
    const plan = planSecrets(optional, {}, { purposes: ["instance"], integrations: [] });
    expect(plan).toMatchObject({ ready: true, items: [{ status: "not_needed", required: false }] });
  });

  it("flags values that do not match their pattern", () => {
    const plan = planSecrets(manifest, { ORG: "Not Valid" }, { purposes: ["core"], integrations: [] });
    expect(plan.items[0]?.status).toBe("invalid");
  });

  it("is ready when everything required is present or generatable", () => {
    const plan = planSecrets(manifest, { ORG: "fuse" }, { purposes: ["core", "instance"], integrations: [] });
    expect(plan.ready).toBe(true);
  });

  it("never includes values, so it is safe to hand to another agent", () => {
    const plan = planSecrets(manifest, { ORG: "fuse", SHOP_TOKEN: "super-secret-token" }, { purposes: ["core"], integrations: ["shop"] });
    expect(JSON.stringify(plan)).not.toContain("super-secret-token");
  });
});

describe("generateSecret", () => {
  it("produces hex of the declared length", () => {
    const value = generateSecret(manifest.entries[1]!, (n) => new Uint8Array(n).fill(171));
    expect(value).toBe("ab".repeat(32));
  });

  it("produces base64url", () => {
    const entry = { ...manifest.entries[1]!, generate: { method: "random_base64url" as const, bytes: 16 } };
    expect(generateSecret(entry, (n) => new Uint8Array(n).fill(255))).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("refuses entries without a generate method", () => {
    expect(() => generateSecret(manifest.entries[0]!, (n) => new Uint8Array(n))).toThrow();
  });
});

describe("parseManifest", () => {
  it("rejects duplicate names", () => {
    expect(() => parseManifest({ version: 1, entries: [manifest.entries[0], manifest.entries[0]] })).toThrow(/duplicate/);
  });

  it("rejects config examples that fail their own pattern", () => {
    expect(() =>
      parseManifest({ version: 1, entries: [{ ...manifest.entries[0], example: "BAD EXAMPLE" }] }),
    ).toThrow(/example/);
  });
});

describe("redact", () => {
  it("hides short values entirely and long values mostly", () => {
    expect(redact("abc")).toBe("****");
    expect(redact("abcdefghijklmnop")).toBe("abcd…op (16 chars)");
  });
});

describe("the real manifest", () => {
  it("is valid", () => {
    expect(() => realManifest()).not.toThrow();
  });

  it("documents every setting the runtime reads", async () => {
    const { InstanceConfigSchema } = await import("../../server/src/config.js");
    const documented = new Set(realManifest().entries.map((e) => e.name));
    const runtimeKeys = [...Object.keys(ConfigSchema.shape), ...Object.keys(InstanceConfigSchema.shape)].filter(
      (k) => !["NODE_ENV", "PORT", "MIGRATE_ON_START"].includes(k),
    );
    expect(runtimeKeys.filter((k) => !documented.has(k))).toEqual([]);
  });

  it("generates every secret the instance can make itself", () => {
    const generated = realManifest().entries.filter((e) => e.generate).map((e) => e.name);
    expect(generated).toEqual(expect.arrayContaining(["INSTANCE_API_KEY", "WEBHOOK_SIGNING_SECRET"]));
  });
});
