import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SandboxCheck } from "@karatos/core";
import { SANDBOX_CHECKS, credentialProblems } from "./sandbox-checks.js";

const WORKFLOW = readFileSync(new URL("../.github/workflows/sandbox-run.yml", import.meta.url), "utf8");

const check = (credentials: string[]): SandboxCheck => ({
  integration: "shopify",
  name: "Shopify",
  credentials,
  connector: () => {
    throw new Error("not used");
  },
});

describe("sandbox checks", () => {
  it("pass every registered check's credentials to the nightly job under sandbox-only names", () => {
    expect(credentialProblems(SANDBOX_CHECKS, WORKFLOW)).toEqual([]);
  });

  it("catch a credential that isn't passed to the job or isn't a sandbox name", () => {
    const workflow = "          SANDBOX_SHOPIFY_ADMIN_TOKEN: ${{ secrets.SANDBOX_SHOPIFY_ADMIN_TOKEN }}\n";
    expect(credentialProblems([check(["SANDBOX_SHOPIFY_ADMIN_TOKEN"])], workflow)).toEqual([]);
    expect(credentialProblems([check(["SANDBOX_SHOPIFY_WEBHOOK_SECRET", "SHOPIFY_ADMIN_ACCESS_TOKEN"])], workflow)).toEqual([
      "shopify: SANDBOX_SHOPIFY_WEBHOOK_SECRET isn't passed to the job in sandbox-run.yml",
      "shopify: credential SHOPIFY_ADMIN_ACCESS_TOKEN must be named SANDBOX_SHOPIFY_<WHAT>",
      "shopify: SHOPIFY_ADMIN_ACCESS_TOKEN isn't passed to the job in sandbox-run.yml",
    ]);
  });
});
