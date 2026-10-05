import { describe, expect, it } from "vitest";
import { RegistryDocumentationSource } from "../src/index.js";

const expected = [
  { id: "arch", title: "System Architecture", version: "0.2.0" },
  { id: "retail", title: "Retail Playbook", version: "1.0.0" },
];

describe("RegistryDocumentationSource", () => {
  it("is fresh when every document is at the expected version", async () => {
    const source = new RegistryDocumentationSource(expected, async () => [
      { id: "arch", version: "0.2.0" },
      { id: "retail", version: "1.0.0" },
      { id: "extra", version: "9" },
    ]);
    expect(await source.current()).toEqual({ documentIds: ["arch", "retail"], stale: false });
  });

  it("reports missing and changed documents as drift", async () => {
    const source = new RegistryDocumentationSource(expected, async () => [{ id: "arch", version: "0.3.0" }]);
    const state = await source.current();
    expect(state.stale).toBe(true);
    expect(state.reason).toBe("System Architecture is at 0.3.0, expected 0.2.0; Retail Playbook is missing");
  });

  it("treats an unreachable document store as stale", async () => {
    const source = new RegistryDocumentationSource(expected, async () => {
      throw new Error("timeout");
    });
    expect(await source.current()).toMatchObject({ stale: true, reason: "documentation store unreachable: timeout" });
  });
});
