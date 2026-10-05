import { describe, expect, it } from "vitest";
import { findSecrets } from "./secrets-patterns.mjs";

// Fake credentials built at runtime so this file never trips the scanner itself.
const fake = (...parts: string[]) => parts.join("");

describe("findSecrets", () => {
  it.each([
    ["Anthropic key", fake("sk-ant-", "api03-", "x".repeat(40))],
    ["Stripe live key", fake("sk_", "live_", "a".repeat(24))],
    ["Shopify token", fake("shpat_", "0".repeat(32))],
    ["Slack token", fake("xoxb-", "1234567890-abcdef")],
    ["GitHub token", fake("ghp_", "A".repeat(36))],
    ["JWT (e.g. Supabase key)", fake("eyJ", "hbGciOiJIUzI1", ".eyJ", "yb2xlIjoiYW5v", ".", "s".repeat(20))],
    ["Private key", fake("-----BEGIN ", "RSA PRIVATE KEY-----")],
    ["Postgres URL with password", fake("postgresql://postgres:", "hunter2hunter2", "@db.abc.supabase.co:5432/postgres")],
  ])("flags a %s", (label, text) => {
    expect(findSecrets(`const x = "${text}";`)).toContain(label);
  });

  it.each([
    ["the env template", "SUPABASE_ANON_KEY=\nSTRIPE_SECRET_KEY="],
    ["placeholder database URLs", "postgresql://user:pass@db.example.supabase.co:5432/postgres"],
    ["templated database URLs", "postgresql://postgres:<password>@db.x.supabase.co:5432/postgres"],
    ["throwaway CI database URLs", "postgresql://postgres:postgres@127.0.0.1:5432/postgres"],
    ["a Stripe test key", fake("sk_", "test_", "a".repeat(24))],
    ["ordinary prose", "Brain A turns events into recommendations."],
  ])("ignores %s", (_label, text) => {
    expect(findSecrets(text)).toEqual([]);
  });
});
