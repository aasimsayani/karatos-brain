import { describe, expect, it } from "vitest";
import {
  catalogDocuments,
  chunkDocument,
  chunkEmbeddingText,
  cosineSimilarity,
  DOC_CHUNK_MAX_CHARS,
  DOC_SEARCH_MAX_QUERY_CHARS,
  DOC_SEARCH_MAX_RESULTS,
  DocumentIndex,
  HASHING_EMBEDDER_DIMENSIONS,
  HASHING_EMBEDDER_ID,
  HashingEmbedder,
  InMemoryDocChunkStore,
  RegistryDocumentationSource,
  searchTerms,
  sha256Hex,
  textVersion,
  type Embedder,
  type IntegrationSpec,
  type SearchableDocument,
} from "../src/index.js";

const ORG = "example-jewelers";

const doc = (text: string, overrides: Partial<SearchableDocument> = {}): SearchableDocument => ({ id: "docs/guide.md", title: "Guide", version: "v1", source: "docs/guide.md", text, ...overrides });

/** An embedder that counts what it is asked to embed, around the built-in one. */
class CountingEmbedder implements Embedder {
  readonly inner = new HashingEmbedder();
  readonly id = this.inner.id;
  readonly dimensions = this.inner.dimensions;
  texts: string[] = [];
  calls = 0;
  async embed(texts: readonly string[]) {
    this.calls++;
    this.texts.push(...texts);
    return this.inner.embed(texts);
  }
}

describe("chunkDocument", () => {
  it("gives no passages for an empty document, or one of only headings and blank lines", () => {
    expect(chunkDocument(doc(""))).toEqual([]);
    expect(chunkDocument(doc("\n\n   \n"))).toEqual([]);
    expect(chunkDocument(doc("# Title\n\n## Empty section\n\n### Also empty\n"))).toEqual([]);
  });

  it("keeps text before the first heading under an empty heading, and nests headings outermost first", () => {
    const chunks = chunkDocument(doc("Intro line.\n\n# Shopify\n\nConnect the store.\n\n## Settings\n\nSet the domain.\n\n### Token\n\nPaste it.\n\n## Events\n\nOrders come in."));
    expect(chunks.map((c) => [c.ordinal, c.heading, c.text])).toEqual([
      [0, "", "Intro line."],
      [1, "Shopify", "Connect the store."],
      [2, "Shopify > Settings", "Set the domain."],
      [3, "Shopify > Settings > Token", "Paste it."],
      [4, "Shopify > Events", "Orders come in."],
    ]);
    expect(chunks.every((c) => c.documentId === "docs/guide.md")).toBe(true);
  });

  it("drops a skipped heading level rather than leaving a gap, and strips closing hashes", () => {
    const chunks = chunkDocument(doc("# Top ##\n\n### Deep ###\n\nText."));
    expect(chunks.map((c) => c.heading)).toEqual(["Top > Deep"]);
  });

  it("does not read a # line inside a code fence as a heading, and keeps the fence in one passage", () => {
    const fenced = "```sh\n# not a heading\nnpm run build\n```";
    const chunks = chunkDocument(doc(`# Build\n\n${fenced}\n\nAfter the fence.\n\n~~~\n## also not\n\n~~~\n\n## Real`));
    expect(chunks.map((c) => c.heading)).toEqual(["Build"]);
    expect(chunks[0]!.text).toBe(`${fenced}\n\nAfter the fence.\n\n~~~\n## also not\n\n~~~`);
  });

  it("closes a fence only on a line of the same character at least as long", () => {
    const chunks = chunkDocument(doc("````\n```\n# inside\n````\n\n# Out\n\nText."));
    expect(chunks.map((c) => c.heading)).toEqual(["", "Out"]);
    expect(chunks[0]!.text).toBe("````\n```\n# inside\n````");
  });

  it("reads Windows line endings", () => {
    expect(chunkDocument(doc("# A\r\n\r\nOne.\r\n\r\n# B\r\n\r\nTwo.")).map((c) => [c.heading, c.text])).toEqual([
      ["A", "One."],
      ["B", "Two."],
    ]);
  });

  it("packs short paragraphs together up to the limit, never across a heading", () => {
    const para = "word ".repeat(19).trim(); // 94 characters
    const chunks = chunkDocument(doc(`# A\n\n${Array(5).fill(para).join("\n\n")}\n\n# B\n\n${para}`), 200);
    expect(chunks.map((c) => [c.heading, c.text.length])).toEqual([
      ["A", 190],
      ["A", 190],
      ["A", 94],
      ["B", 94],
    ]);
    expect(chunks.every((c) => c.text.length <= 200)).toBe(true);
  });

  it("splits a paragraph that is too long by lines, then sentences, then words, then characters", () => {
    const sentence = "This is one sentence of the guide.";
    const long = Array(10).fill(sentence).join(" ");
    const lines = Array(10).fill(sentence).join("\n");
    const oneWord = "x".repeat(130);
    const words = Array(30).fill("abcdefgh").join(" ");
    for (const text of [long, lines, oneWord, words]) {
      const chunks = chunkDocument(doc(text), 60);
      expect(chunks.length, text.slice(0, 20)).toBeGreaterThan(1);
      expect(chunks.every((c) => c.text.length <= 60)).toBe(true);
      // Nothing is lost but the whitespace between pieces.
      expect(chunks.map((c) => c.text).join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
    }
    expect(chunkDocument(doc(long), 60)[0]!.text).toBe(sentence);
    expect(chunkDocument(doc(lines), 80)[0]!.text).toBe(`${sentence}\n${sentence}`);
    expect(chunkDocument(doc(oneWord), 60).map((c) => c.text.length)).toEqual([60, 60, 10]);
  });

  it("hashes what is embedded: the title, heading and text", () => {
    const [chunk] = chunkDocument(doc("# Payouts\n\nLate payouts are flagged."));
    expect(chunk!.contentHash).toBe(sha256Hex(chunkEmbeddingText("Guide", "Payouts", "Late payouts are flagged.")));
    expect(chunkEmbeddingText("T", "", "x")).toBe("T\nx");
    const [renamed] = chunkDocument(doc("# Payouts\n\nLate payouts are flagged.", { title: "Other" }));
    expect(renamed!.contentHash).not.toBe(chunk!.contentHash);
    const [moved] = chunkDocument(doc("# Payouts\n\nLate payouts are flagged.", { version: "v2", source: "elsewhere" }));
    expect(moved!.contentHash).toBe(chunk!.contentHash);
  });

  it("uses an 800 character limit by default and turns down one too small to be useful", () => {
    expect(DOC_CHUNK_MAX_CHARS).toBe(800);
    const chunks = chunkDocument(doc(Array(40).fill("A sentence that runs on for a while.").join(" ")));
    expect(Math.max(...chunks.map((c) => c.text.length))).toBeLessThanOrEqual(800);
    expect(chunks[0]!.text.length).toBeGreaterThan(750);
    expect(() => chunkDocument(doc("x"), 49)).toThrow(RangeError);
    expect(() => chunkDocument(doc("x"), 50.5)).toThrow(RangeError);
    expect(chunkDocument(doc("x"), 50)).toHaveLength(1);
  });
});

describe("HashingEmbedder", () => {
  const embedder = new HashingEmbedder();

  it("is deterministic, of a fixed dimension, and length 1", async () => {
    const [a, b] = await embedder.embed(["Where is the Stripe payout setting?", "Where is the Stripe payout setting?"]);
    expect(a).toEqual(b);
    expect(a).toHaveLength(HASHING_EMBEDDER_DIMENSIONS);
    expect(Math.hypot(...a!)).toBeCloseTo(1, 10);
    expect(embedder.id).toBe(HASHING_EMBEDDER_ID);
    expect(HASHING_EMBEDDER_DIMENSIONS).toBe(1024);
  });

  it("gives zeros for text with no search terms", async () => {
    const [v] = await embedder.embed(["the and of | --- |"]);
    expect(v!.every((x) => x === 0)).toBe(true);
  });

  it("names a different dimension count in its id, and turns down impossible ones", () => {
    expect(new HashingEmbedder(64).id).toBe(`${HASHING_EMBEDDER_ID}-64`);
    expect(new HashingEmbedder(64).embedOne("payout")).toHaveLength(64);
    for (const bad of [15, 4097, 100.5]) expect(() => new HashingEmbedder(bad), String(bad)).toThrow(RangeError);
    expect(new HashingEmbedder(16).dimensions).toBe(16);
    expect(new HashingEmbedder(4096).dimensions).toBe(4096);
  });

  it("puts texts that share words closer than texts that don't", () => {
    const q = embedder.embedOne("late payouts from Stripe");
    const near = embedder.embedOne("Stripe payouts that arrive late are flagged");
    const far = embedder.embedOne("UPS tracking numbers file for packages");
    expect(cosineSimilarity(q, near)).toBeGreaterThan(0.3);
    expect(Math.abs(cosineSimilarity(q, far))).toBeLessThan(0.15);
  });

  it("counts a repeated word less than linearly, and word order through neighbouring pairs", () => {
    // With room enough that nothing collides, each feature is one non-zero position.
    const wide = new HashingEmbedder(4096);
    const magnitudes = (text: string) => wide.embedOne(text).filter((v) => v !== 0).map(Math.abs).sort((a, b) => b - a);
    expect(magnitudes("ring")).toEqual([1]);
    // "ring ring": the word at 1 + ln 2, and the pair "ring ring" at 0.5.
    const [word, pair] = magnitudes("ring ring");
    expect(word! / pair!).toBeCloseTo((1 + Math.log(2)) / 0.5, 10);
    const [w4, p4] = magnitudes("ring ring ring ring");
    // The word four times, the pair three times.
    expect(w4! / p4!).toBeCloseTo((1 + Math.log(4)) / (0.5 * (1 + Math.log(3))), 10);
    const ab = embedder.embedOne("gold price");
    const ba = embedder.embedOne("price gold");
    expect(cosineSimilarity(ab, ba)).toBeLessThan(0.999);
    expect(cosineSimilarity(ab, ba)).toBeGreaterThan(0.5);
  });
});

describe("searchTerms", () => {
  it("lowercases, drops accents, stop words and single letters, and stems", () => {
    expect(searchTerms("How do I see the Payouts and Settings?")).toEqual(["see", "payout", "setting"]);
    expect(searchTerms("Café rings, stories, classes, tracked, a b UPS_CLIENT_ID")).toEqual(["cafe", "ring", "story", "class", "track", "ups", "client", "id"]);
    expect(searchTerms("is was ss bus")).toEqual(["ss", "bus"]);
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for the same direction, -1 for opposite, 0 for zeros or a length mismatch", () => {
    expect(cosineSimilarity([1, 2], [2, 4])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [-3, 0])).toBeCloseTo(-1);
    expect(cosineSimilarity([1, 0], [0, 5])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 1], [0, 0])).toBe(0);
    expect(cosineSimilarity([1, 1], [1, 1, 1])).toBe(0);
  });
});

const CORPUS: SearchableDocument[] = [
  {
    id: "docs/integrations/ups.md",
    title: "UPS tracking",
    version: "v1",
    source: "docs/integrations/ups.md",
    text: "# UPS tracking\n\nFollows packages on the business's list.\n\n## Settings\n\nSet UPS_CLIENT_ID and UPS_CLIENT_SECRET from a UPS developer app, and UPS_TRACKING_NUMBERS_FILE to the file of tracking numbers.\n\n## Events\n\nshipment.tracked carries the package status.",
  },
  {
    id: "docs/integrations/stripe.md",
    title: "Stripe",
    version: "v1",
    source: "docs/integrations/stripe.md",
    text: "# Stripe\n\nReads charges, refunds, disputes and payouts.\n\n## Settings\n\nSet STRIPE_SECRET_KEY to a restricted key with read access.\n\n## Payouts\n\nA payout that hasn't arrived by its expected day is flagged as late.",
  },
  {
    id: "docs/security.md",
    title: "Security",
    version: "v1",
    source: "docs/security.md",
    text: "# Security\n\n## Support access\n\nThe support key reaches only diagnostic routes, never business data.",
  },
];

describe("DocumentIndex", () => {
  const setup = (embedder: Embedder = new CountingEmbedder(), store = new InMemoryDocChunkStore()) => ({
    store,
    embedder,
    index: new DocumentIndex({ store, organizationId: ORG, embedder, now: () => new Date("2026-11-28T12:00:00Z") }),
  });

  it("embeds every passage the first time, then nothing when nothing changed", async () => {
    const { index, embedder } = setup();
    const first = await index.sync(CORPUS);
    expect(first).toEqual({ documents: 3, unchanged: 0, saved: 3, removed: 0, chunks: 7, embedded: 7, reused: 0 });
    const counting = embedder as CountingEmbedder;
    expect(counting.texts).toHaveLength(7);
    counting.texts = [];
    expect(await index.sync(CORPUS)).toEqual({ documents: 3, unchanged: 3, saved: 0, removed: 0, chunks: 7, embedded: 0, reused: 7 });
    expect(counting.texts).toEqual([]);
  });

  it("re-embeds only the passages whose text changed, even when ordinals shift", async () => {
    const { index, embedder, store } = setup();
    await index.sync(CORPUS);
    const counting = embedder as CountingEmbedder;
    counting.texts = [];
    const stripe = CORPUS[1]!;
    // A new section in the middle, and an edit to the last one.
    const edited = {
      ...stripe,
      version: "v2",
      text: stripe.text.replace("## Payouts", "## Disputes\n\nDisputes are listed with their deadline.\n\n## Payouts").replace("flagged as late.", "flagged as late on the morning brief."),
    };
    const result = await index.sync([CORPUS[0]!, edited, CORPUS[2]!]);
    expect(result).toEqual({ documents: 3, unchanged: 2, saved: 1, removed: 0, chunks: 8, embedded: 2, reused: 6 });
    expect(counting.texts).toEqual([
      chunkEmbeddingText("Stripe", "Stripe > Disputes", "Disputes are listed with their deadline."),
      chunkEmbeddingText("Stripe", "Stripe > Payouts", "A payout that hasn't arrived by its expected day is flagged as late on the morning brief."),
    ]);
    const stored = await store.chunks(ORG, stripe.id);
    expect(stored.map((c) => c.ordinal)).toEqual([0, 1, 2, 3]);
    expect(stored.map((c) => c.heading)).toEqual(["Stripe", "Stripe > Settings", "Stripe > Disputes", "Stripe > Payouts"]);
    // The kept passage's vector is the one stored before, not a new one.
    const fresh = new HashingEmbedder().embedOne(chunkEmbeddingText("Stripe", "Stripe > Settings", "Set STRIPE_SECRET_KEY to a restricted key with read access."));
    expect(stored[1]!.embedding).toEqual(fresh);
    expect((await store.documents(ORG)).find((d) => d.id === stripe.id)?.version).toBe("v2");
  });

  it("saves a new version, title or source without re-embedding text that is the same", async () => {
    const { index, embedder, store } = setup();
    await index.sync(CORPUS);
    const counting = embedder as CountingEmbedder;
    counting.texts = [];
    const result = await index.sync([{ ...CORPUS[0]!, version: "v9", source: "docs/ups.md" }, CORPUS[1]!, CORPUS[2]!]);
    expect(result).toMatchObject({ unchanged: 2, saved: 1, embedded: 0, reused: 7 });
    expect((await store.documents(ORG)).find((d) => d.id === CORPUS[0]!.id)).toEqual({ id: CORPUS[0]!.id, title: "UPS tracking", version: "v9", source: "docs/ups.md" });
    // A new title is in every passage's embedded text, so all of them change.
    const retitled = await index.sync([{ ...CORPUS[0]!, title: "UPS" }, CORPUS[1]!, CORPUS[2]!]);
    expect(retitled).toMatchObject({ saved: 1, embedded: 3 });
  });

  it("embeds a passage repeated within a document once", async () => {
    const { index, embedder } = setup();
    const result = await index.sync([doc("# A\n\nSame text.\n\n# A\n\nSame text.")]);
    expect(result).toMatchObject({ chunks: 2, embedded: 1, reused: 1 });
    expect((embedder as CountingEmbedder).calls).toBe(1);
  });

  it("skips the embedder when a changed document has only passages it holds", async () => {
    const { index, embedder } = setup();
    await index.sync([doc("# A\n\nOne.\n\n# B\n\nTwo.")]);
    const counting = embedder as CountingEmbedder;
    counting.calls = 0;
    // Same passages, reordered.
    expect(await index.sync([doc("# B\n\nTwo.\n\n# A\n\nOne.")])).toMatchObject({ saved: 1, embedded: 0, reused: 2 });
    expect(counting.calls).toBe(0);
  });

  it("removes documents no longer given", async () => {
    const { index, store } = setup();
    await index.sync(CORPUS);
    expect(await index.sync([CORPUS[0]!])).toMatchObject({ documents: 1, unchanged: 1, removed: 2 });
    expect((await store.documents(ORG)).map((d) => d.id)).toEqual([CORPUS[0]!.id]);
    expect(await store.chunks(ORG, CORPUS[1]!.id)).toEqual([]);
    expect(await index.sync([])).toMatchObject({ documents: 0, removed: 1, chunks: 0 });
  });

  it("re-embeds everything once when the embedder changes", async () => {
    const store = new InMemoryDocChunkStore();
    await setup(new HashingEmbedder(), store).index.sync(CORPUS);
    const other = new HashingEmbedder(64);
    const { index } = setup(other, store);
    expect(await index.sync(CORPUS)).toMatchObject({ saved: 3, embedded: 7, reused: 0 });
    expect((await store.chunks(ORG, CORPUS[0]!.id)).every((c) => c.embedder === other.id && c.embedding.length === 64)).toBe(true);
    // A search by the old embedder finds nothing; by the new one it does.
    expect(await setup(new HashingEmbedder(), store).index.search("UPS client secret")).toEqual([]);
    expect((await index.search("UPS client secret"))[0]?.documentId).toBe(CORPUS[0]!.id);
  });

  it("turns down a document without an id or one given twice, before changing anything", async () => {
    const { index, store } = setup();
    await expect(index.sync([{ ...CORPUS[0]!, id: "" }])).rejects.toThrow("every document needs an id");
    await expect(index.sync([CORPUS[0]!, CORPUS[0]!])).rejects.toThrow(`document ${CORPUS[0]!.id} is given twice`);
    expect(await store.documents(ORG)).toEqual([]);
  });

  it("turns down vectors that are missing, short or not finite", async () => {
    const bad = (vectors: (texts: readonly string[]) => number[][]): Embedder => ({ id: "bad", dimensions: 4, embed: async (texts) => vectors(texts) });
    const cases: [string, Embedder, string][] = [
      ["count", bad(() => []), "embedder bad returned 0 vectors for 3 texts"],
      ["not an array", bad(() => null as unknown as number[][]), "embedder bad returned no vectors for 3 texts"],
      ["dimensions", bad((t) => t.map(() => [1, 0, 0])), "embedder bad returned a vector that isn't 4 finite numbers"],
      ["finite", bad((t) => t.map(() => [1, 0, 0, Number.NaN])), "embedder bad returned a vector that isn't 4 finite numbers"],
      ["array", bad((t) => t.map(() => "nope" as unknown as number[])), "embedder bad returned a vector that isn't 4 finite numbers"],
    ];
    for (const [name, embedder, message] of cases) {
      const { index, store } = setup(embedder);
      await expect(index.sync([CORPUS[0]!]), name).rejects.toThrow(message);
      expect(await store.documents(ORG), name).toEqual([]);
    }
    await expect(setup(bad(() => [])).index.search("ups")).rejects.toThrow("embedder bad returned 0 vectors for 1 texts");
  });

  it("ranks the passage that answers the question first, with its source, heading, version and score", async () => {
    const { index } = setup();
    await index.sync(CORPUS);
    const hits = await index.search("Where do I put the UPS client secret?");
    expect(hits[0]).toEqual({
      documentId: "docs/integrations/ups.md",
      title: "UPS tracking",
      source: "docs/integrations/ups.md",
      version: "v1",
      heading: "UPS tracking > Settings",
      text: expect.stringContaining("UPS_CLIENT_SECRET"),
      score: expect.any(Number),
    });
    expect(hits[0]!.score).toBeGreaterThan(0.2);
    for (let i = 1; i < hits.length; i++) expect(hits[i]!.score).toBeLessThanOrEqual(hits[i - 1]!.score);
    expect((await index.search("how do I tell if a Stripe payout is late"))[0]?.heading).toBe("Stripe > Payouts");
    expect((await index.search("what can the support key reach"))[0]?.documentId).toBe("docs/security.md");
  });

  it("rounds scores to four places and leaves out passages that share nothing with the query", async () => {
    const { index } = setup();
    await index.sync(CORPUS);
    const hits = await index.search("UPS tracking");
    expect(hits.every((h) => Math.round(h.score * 10_000) / 10_000 === h.score && h.score >= 0.05)).toBe(true);
    expect(hits.some((h) => h.documentId === "docs/security.md")).toBe(false);
    expect(await index.search("zebra xylophone quantum")).toEqual([]);
    expect(await index.search("the and of")).toEqual([]);
    expect(await index.search("   ")).toEqual([]);
  });

  it("returns at most the limit asked for, from 1 to 20, defaulting to 5", async () => {
    const { index } = setup();
    const many = Array.from({ length: 30 }, (_, i) => doc(`# Ring ${i}\n\nRing sizing guide number ${i}.`, { id: `ring-${i}` }));
    await index.sync(many);
    expect(await index.search("ring sizing")).toHaveLength(5);
    expect(await index.search("ring sizing", 3)).toHaveLength(3);
    expect(await index.search("ring sizing", 100)).toHaveLength(DOC_SEARCH_MAX_RESULTS);
    expect(await index.search("ring sizing", 0)).toHaveLength(1);
    expect(await index.search("ring sizing", -4)).toHaveLength(1);
    expect(await index.search("ring sizing", Number.NaN)).toHaveLength(1);
    expect(await index.search("ring sizing", 2.9)).toHaveLength(2);
  });

  it("shows a passage found word for word in two documents once, and still fills the limit", async () => {
    const { index } = setup();
    const page = doc("# Rings\n\nResizing a ring takes a week.", { id: "docs/integrations/rings.md" });
    const list = doc("# Integrations\n\n## Rings\n\nResizing a ring takes a week.", { id: "docs/integrations.md" });
    const other = doc("# Repairs\n\nA ring resizing repair is tracked from intake.", { id: "docs/repairs.md" });
    await index.sync([page, list, other]);
    const hits = await index.search("resizing a ring", 2);
    expect(hits.map((h) => h.documentId)).toHaveLength(2);
    expect(hits.filter((h) => h.text === "Resizing a ring takes a week.")).toHaveLength(1);
    expect(hits.some((h) => h.documentId === "docs/repairs.md")).toBe(true);
  });

  it("reads only the first 500 characters of a query", async () => {
    const embedder = new CountingEmbedder();
    const { index } = setup(embedder);
    await index.sync(CORPUS);
    embedder.texts = [];
    await index.search(`${"a".repeat(DOC_SEARCH_MAX_QUERY_CHARS)}ups`);
    expect(embedder.texts).toEqual(["a".repeat(DOC_SEARCH_MAX_QUERY_CHARS)]);
  });

  it("keeps organizations apart", async () => {
    const store = new InMemoryDocChunkStore();
    await new DocumentIndex({ store, organizationId: "other" }).sync(CORPUS);
    const { index } = setup(new HashingEmbedder(), store);
    expect(await index.search("UPS client secret")).toEqual([]);
    expect(await index.current()).toEqual([]);
  });

  it("tells the registry's drift check what it holds", async () => {
    const { index } = setup();
    await index.sync(CORPUS);
    expect(await index.current()).toEqual(CORPUS.map((d) => ({ id: d.id, version: "v1" })));
    const registry = CORPUS.map(({ id, title }) => ({ id, title, version: "v1" }));
    expect(await new RegistryDocumentationSource(registry, () => index.current()).current()).toEqual({ documentIds: CORPUS.map((d) => d.id), stale: false });
    await index.sync([CORPUS[0]!, { ...CORPUS[1]!, version: "v2" }]);
    expect(await new RegistryDocumentationSource(registry, () => index.current()).current()).toEqual({
      documentIds: CORPUS.map((d) => d.id),
      stale: true,
      reason: "Stripe is at v2, expected v1; Security is missing",
    });
  });
});

describe("catalogDocuments", () => {
  const spec = (overrides: Partial<IntegrationSpec>): IntegrationSpec =>
    ({ id: "ups", name: "UPS", domain: "shipping", segments: ["retail"], access: "public_api", testWith: "sandbox", departments: [], historicalImportYears: 1, webhooks: false, settings: [], changelog: null, status: "planned", ...overrides }) as IntegrationSpec;

  it("writes one document per integration from the catalog, with its settings and changelog", () => {
    const [d] = catalogDocuments([
      spec({ status: "built", note: "Reads tracking.", capabilities: ["Follows packages"], settings: ["UPS_CLIENT_ID"], signIn: [["UPS_CLIENT_SECRET"], ["UPS_OTHER"]], changelog: "https://example.test/changes" }),
    ]);
    expect(d).toMatchObject({ id: "catalog/ups", title: "UPS", source: "catalog:ups" });
    expect(d!.text).toBe(
      [
        "# UPS",
        "",
        "UPS is a shipping system (public api), with a built connector.",
        "",
        "Reads tracking.",
        "",
        "What it does:",
        "- Follows packages",
        "",
        "Settings, kept in the instance's secrets: UPS_CLIENT_ID, UPS_CLIENT_SECRET.",
        "",
        "UPS publishes API changes at https://example.test/changes; the daily vendor docs watch follows it.",
      ].join("\n"),
    );
    expect(d!.version).toBe(textVersion(d!.text));
    expect(textVersion("x")).toMatch(/^sha256:[0-9a-f]{12}$/);
  });

  it("leaves out sections an integration has nothing for", () => {
    const [d] = catalogDocuments([spec({ status: "deferred" })]);
    expect(d!.text).toBe("# UPS\n\nUPS is a shipping system (public api), with its connector deferred.");
    const [s] = catalogDocuments([spec({ signIn: [["A_KEY"]] })]);
    expect(s!.text).toBe("# UPS\n\nUPS is a shipping system (public api), with its connector planned.\n\nSettings, kept in the instance's secrets: A_KEY.");
    expect(chunkDocument(s!)).toHaveLength(1);
  });

  it("covers the whole catalog by default, each searchable", async () => {
    const docs = catalogDocuments();
    expect(docs.length).toBeGreaterThan(50);
    expect(new Set(docs.map((d) => d.id)).size).toBe(docs.length);
    const index = new DocumentIndex({ store: new InMemoryDocChunkStore(), organizationId: ORG });
    await index.sync(docs);
    expect((await index.search("Shopify client secret"))[0]?.documentId).toBe("catalog/shopify");
  });
});
