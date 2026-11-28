import { describe, expect, it } from "vitest";
import type { DocSearchHit } from "@karatos/core";
import { answerQuestion, ASK_DOC_PASSAGES, ASK_DOC_QUOTE_CHARS, ASK_EVENT_TYPES, ASK_QUESTIONS, isHowTo, normalizeQuestion, routeQuestion, type AskData } from "../src/index.js";

const clock = { now: new Date("2026-11-20T15:00:00.000Z"), timeZone: "America/New_York" };
const data: AskData = { organizationId: "example-jewelers", timeZone: "America/New_York", generatedAt: "2026-11-20T15:00:00.000Z" };
const route = (q: string) => routeQuestion(q, clock);

const hit = (overrides: Partial<DocSearchHit> = {}): DocSearchHit => ({
  documentId: "docs/integrations/shopify.md",
  title: "Shopify",
  source: "docs/integrations/shopify.md",
  version: "sha256:bbbbbbbbbbbb",
  heading: "Shopify > Connecting",
  text: "Create a custom app in the Shopify admin.",
  score: 0.42,
  ...overrides,
});

describe("asking how to do or find something", () => {
  it("routes how-do-I and where-is questions to the documentation", () => {
    for (const q of [
      "How do I connect Shopify?",
      "how can we turn on support access",
      "How should I set the store hours?",
      "How to add a connector",
      "Where is the UPS tracking numbers file set?",
      "Where's the Stripe payout setting?",
      "where do I put the Square token",
      "Hey, how do I see sync errors?",
      "okay where are the bench limits",
      "Which setting controls the brief hour?",
      "what settings does Klaviyo need",
      "How would you connect QuickBooks?",
      "how could we connect Xero",
      "where does the brief go",
      "where can I find the logs",
      "where should I put the key",
      "where would I see payouts",
      "where did the docs go",
      "please, how do I connect Etsy",
      "so where is the setting",
      "hi how to start",
    ]) {
      expect(route(q), q).toEqual({ kind: "intent", intent: "docs" });
    }
  });

  it("leaves a question that names a period, or isn't phrased as how-to, to the other answers", () => {
    expect(route("How do I see what sold yesterday?")).toMatchObject({ kind: "intent", intent: "sales", period: { fromDay: "2026-11-19" } });
    expect(route("how many employees do we have")).toEqual({ kind: "unsupported" });
    expect(route("How much did we make yesterday?")).toMatchObject({ intent: "sales" });
    expect(route("Which payouts are late?")).toEqual({ kind: "intent", intent: "payouts" });
    expect(route("Is everything syncing? how do I fix it")).toEqual({ kind: "intent", intent: "sync_health" });
    expect(route("how are sales")).toMatchObject({ intent: "sales" });
    expect(route("somewhere is a payout")).toEqual({ kind: "intent", intent: "payouts" });
    expect(route("how do I see sales on 13/11")).toMatchObject({ kind: "unclear_period" });
    expect(isHowTo(normalizeQuestion("however do itemized"))).toBe(false);
    expect(isHowTo(normalizeQuestion("how doing"))).toBe(false);
    expect(isHowTo(normalizeQuestion("where isabel"))).toBe(false);
    expect(isHowTo(normalizeQuestion("how do icons work"))).toBe(false);
  });

  it("lists documentation among what can be asked, read from no events", () => {
    expect(ASK_QUESTIONS.find((q) => q.intent === "docs")).toEqual({ intent: "docs", example: "How do I connect Shopify?", answers: "how to set up and use KaratOS and the systems it connects, from the documentation this instance has" });
    expect(ASK_EVENT_TYPES.docs).toEqual([]);
    expect(answerQuestion("hello", { kind: "unsupported" }, data).text).toContain('- "How do I connect Shopify?" (how to set up and use KaratOS');
  });

  it("quotes the closest passages, each with its heading and source", () => {
    const passages = [hit(), hit({ documentId: "catalog/shopify", title: "Shopify", heading: "", source: "catalog:shopify", version: "", text: "Settings,\n  kept in the\tinstance's secrets." })];
    const answer = answerQuestion("How do I connect Shopify?", { kind: "intent", intent: "docs" }, { ...data, docs: { passages } });
    expect(answer).toMatchObject({ question: "How do I connect Shopify?", intent: "docs", status: "answered", facts: [], findings: [], passages });
    expect(answer.text).toBe(
      [
        "From the documentation this instance has, closest first:",
        "- Shopify > Connecting: Create a custom app in the Shopify admin. [docs/integrations/shopify.md, sha256:bbbbbbbbbbbb]",
        "- Shopify: Settings, kept in the instance's secrets. [catalog:shopify]",
      ].join("\n"),
    );
  });

  it("quotes at most three passages, each cut near 400 characters at a word", () => {
    expect(ASK_DOC_PASSAGES).toBe(3);
    expect(ASK_DOC_QUOTE_CHARS).toBe(400);
    const long = "word ".repeat(200).trim();
    const answer = answerQuestion("how do I", { kind: "intent", intent: "docs" }, { ...data, docs: { passages: [hit({ text: long }), hit(), hit(), hit({ heading: "Fourth" })] } });
    expect(answer.passages).toHaveLength(3);
    expect(answer.text).not.toContain("Fourth");
    const first = answer.text.split("\n")[1]!;
    const quoted = first.slice("- Shopify > Connecting: ".length, first.indexOf(" [docs/"));
    expect(quoted.endsWith("word…")).toBe(true);
    expect(quoted.length).toBeLessThanOrEqual(ASK_DOC_QUOTE_CHARS + 1);
    expect(quoted.length).toBeGreaterThan(ASK_DOC_QUOTE_CHARS - 10);
    // A run with no space late enough is cut at the limit itself.
    const unbroken = answerQuestion("how do I", { kind: "intent", intent: "docs" }, { ...data, docs: { passages: [hit({ text: `ab ${"x".repeat(600)}` })] } });
    expect(unbroken.text).toContain(`ab ${"x".repeat(ASK_DOC_QUOTE_CHARS - 3)}…`);
    const exact = answerQuestion("how do I", { kind: "intent", intent: "docs" }, { ...data, docs: { passages: [hit({ text: "y".repeat(ASK_DOC_QUOTE_CHARS) })] } });
    expect(exact.text).toContain(`${"y".repeat(ASK_DOC_QUOTE_CHARS)} [`);
  });

  it("says when nothing in the docs is close, or when the instance can't search them", () => {
    const none = answerQuestion("how do I fly", { kind: "intent", intent: "docs" }, { ...data, docs: { passages: [] } });
    expect(none).toMatchObject({ status: "no_data", passages: [] });
    expect(none.text).toBe('I couldn\'t find that in the documentation this instance has. Try naming the system or the setting, such as "How do I connect Shopify?" or "Where is the UPS tracking numbers file set?"');
    const off = answerQuestion("how do I fly", { kind: "intent", intent: "docs" }, data);
    expect(off).toMatchObject({ status: "no_data", text: "Documentation search isn't set up on this instance, so I can't look that up." });
    expect(off.passages).toBeUndefined();
  });
});
