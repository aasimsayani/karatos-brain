import { describe, expect, it } from "vitest";
import { parseEnvFile, upsertEnvFile } from "./env.js";

describe("parseEnvFile", () => {
  it("reads keys, strips matching quotes and ignores comments", () => {
    expect(parseEnvFile("# comment\nA=1\nB=\"two words\"\nC='x'\nD=\n bad line")).toEqual({
      A: "1",
      B: "two words",
      C: "x",
      D: "",
    });
  });
});

describe("upsertEnvFile", () => {
  it("replaces existing keys in place and appends new ones", () => {
    const before = "# Supabase\nSUPABASE_URL=\nOTHER=keep\n";
    expect(upsertEnvFile(before, { SUPABASE_URL: "https://x.supabase.co", NEW_KEY: "v" })).toBe(
      "# Supabase\nSUPABASE_URL=https://x.supabase.co\nOTHER=keep\nNEW_KEY=v\n",
    );
  });

  it("creates a file from nothing", () => {
    expect(upsertEnvFile("", { A: "1" })).toBe("A=1\n");
  });
});
