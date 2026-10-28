import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GENERATED_FILES, mergeOrder, mergePlan, overlaps, renderPlan, retargets, rollUp, settledByTooling, stackedOn, type OpenPr } from "./pr-queue.js";

const pr = (number: number, over: Partial<OpenPr> = {}): OpenPr => ({
  number,
  title: `PR ${number}`,
  head: `branch-${number}`,
  base: "main",
  draft: false,
  files: [],
  checks: "green",
  mergeable: true,
  ...over,
});

describe("the PR queue", () => {
  it("puts a stacked PR after the PR it's stacked on, however far up the stack, and the base that unblocks most first", () => {
    const prs = [pr(5, { base: "branch-9" }), pr(9, { base: "branch-12" }), pr(12), pr(3)];
    expect(mergeOrder(prs).map((p) => p.number)).toEqual([12, 3, 9, 5]);
    expect(stackedOn(prs, 12)).toEqual([5, 9]);
    // Readiness still comes first: a red base waits behind a ready PR.
    expect(mergeOrder([pr(12, { checks: "red" }), pr(9, { base: "branch-12" }), pr(3)]).map((p) => p.number)).toEqual([3, 12, 9]);
  });

  it("shows a PR's three most shared files and counts the rest", () => {
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
    const plan = mergePlan([pr(1, { files }), pr(2, { files }), pr(3, { files: ["e.ts"] })]);
    expect(renderPlan(plan).split("\n").slice(2, 7)).toEqual([
      "1. #3 PR 3 (ready)",
      "   shares e.ts with #1, #2",
      "2. #1 PR 1 (ready)",
      "   shares e.ts with #2, #3",
      "   shares a.ts with #2",
    ]);
    expect(renderPlan(plan)).toContain("   shares b.ts with #2\n   and 2 more shared files\n");
  });

  it("puts ready PRs first in a tier, then the ones sharing the fewest hand-written files, then the oldest", () => {
    const prs = [
      pr(1, { checks: "red" }),
      pr(2, { files: ["packages/server/src/sync.ts"] }),
      pr(3, { files: ["packages/server/src/sync.ts", "docs/integrations.md"] }),
      pr(4, { files: ["packages/connectors/src/four/index.ts", "docs/integrations.md"] }),
      pr(5, { mergeable: null }),
      pr(6, { draft: true }),
    ];
    expect(mergeOrder(prs).map((p) => p.number)).toEqual([4, 2, 3, 1, 5, 6]);
  });

  it("breaks a stack that loops at its lowest-numbered PR instead of hanging", () => {
    const prs = [pr(8, { head: "a", base: "b" }), pr(7, { head: "b", base: "a" })];
    expect(mergeOrder(prs).map((p) => p.number)).toEqual([7, 8]);
    expect(mergePlan(prs).map((s) => s.unblocks)).toEqual([[8], [7]]);
  });

  it("never counts generated lists, the README or changelog fragments as a conflict", () => {
    for (const f of [...GENERATED_FILES, "README.md", "CHANGELOG.md", "changelog.d/x.md"]) expect(settledByTooling(f), f).toBe(true);
    expect(settledByTooling("packages/core/src/integrations.ts")).toBe(false);
    const prs = [pr(1, { files: ["docs/integrations.md", "changelog.d/one.md", "site/build.ts"] }), pr(2, { files: ["docs/integrations.md", "site/build.ts"] })];
    expect([...overlaps(prs)]).toEqual([["site/build.ts", [1, 2]]]);
  });

  it("lists the same generated files the sync script settles by regenerating", () => {
    const script = readFileSync(new URL("./sync-open-prs.sh", import.meta.url), "utf8");
    const listed = /^GENERATED='([^']*)'/m.exec(script)![1]!.split("|");
    expect(listed).toEqual([...GENERATED_FILES]);
  });

  it("says what each PR waits on, what it unblocks and what it shares", () => {
    const prs = [
      pr(334, { title: "Registry", files: ["packages/server/src/sync.ts"] }),
      pr(336, { title: "WatchSearch", base: "branch-334", files: ["packages/connectors/src/watchsearch/index.ts"] }),
      pr(338, { title: "Twilio", base: "branch-336", checks: "running" }),
      pr(229, { title: "Write-back", files: ["packages/server/src/sync.ts"], checks: "red", mergeable: false }),
      pr(174, { title: "Catalog", draft: true }),
    ];
    const plan = mergePlan(prs);
    expect(plan.map((s) => [s.pr.number, s.ready, s.blockers])).toEqual([
      [334, true, []],
      [174, false, ["still a draft"]],
      [229, false, ["CI is red", "conflicts with main"]],
      [336, false, ["after #334 merges"]],
      [338, false, ["after #336 merges", "CI is running"]],
    ]);
    expect(plan[0]!.unblocks).toEqual([336, 338]);
    expect(plan[0]!.shared).toEqual([{ file: "packages/server/src/sync.ts", with: [229] }]);
    expect(renderPlan(plan)).toBe(
      [
        "Merge in this order. Run scripts/sync-open-prs.sh after each merge.",
        "",
        "1. #334 Registry (ready); unblocks #336, #338",
        "   shares packages/server/src/sync.ts with #229",
        "2. #174 Catalog (still a draft)",
        "3. #229 Write-back (CI is red, conflicts with main)",
        "   shares packages/server/src/sync.ts with #334",
        "4. #336 WatchSearch (after #334 merges); unblocks #338",
        "5. #338 Twilio (after #336 merges, CI is running)",
        "",
      ].join("\n"),
    );
  });

  it("names a missing base in the plan when the PR it's stacked on comes later", () => {
    // A loop puts one stacked PR ahead of its base; the plan says so rather than calling it ready.
    const plan = mergePlan([pr(8, { head: "a", base: "b" }), pr(7, { head: "b", base: "a" })]);
    expect(plan[0]!.blockers).toEqual(["merge #8 first"]);
    expect(plan[0]!.ready).toBe(false);
  });

  it("moves PRs stacked on a merged branch onto that branch's base, following merged branches down", () => {
    const open = [pr(336, { base: "connector-registry" }), pr(338, { base: "metals-api" }), pr(170), pr(171, { base: "wip" })];
    const merged = new Map([
      ["connector-registry", "main"],
      ["metals-api", "connector-registry"],
    ]);
    expect(retargets(open, merged)).toEqual([
      { number: 336, from: "connector-registry", to: "main" },
      { number: 338, from: "metals-api", to: "main" },
    ]);
    // Two branches recorded as merged into each other move nothing rather than loop.
    expect(retargets([pr(1, { base: "x" })], new Map([["x", "y"], ["y", "x"]]))).toEqual([]);
  });

  it("rolls check runs up to one state", () => {
    expect(rollUp([])).toBe("none");
    expect(rollUp([{ status: "completed", conclusion: "success" }])).toBe("green");
    expect(rollUp([{ status: "completed", conclusion: "success" }, { status: "in_progress", conclusion: null }])).toBe("running");
    expect(rollUp([{ status: "in_progress", conclusion: null }, { status: "completed", conclusion: "failure" }])).toBe("red");
    expect(rollUp([{ status: "completed", conclusion: "timed_out" }])).toBe("red");
  });
});
