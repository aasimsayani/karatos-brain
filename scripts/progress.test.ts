import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INTEGRATIONS, type IntegrationSpec } from "../packages/core/src/index.js";
import { CONNECTED_END, CONNECTED_START, END, MILESTONES, ProgressError, START, bar, parseMilestones, renderConnected, renderProgress, renderReadme, replaceBlock, replaceProgress } from "./progress.js";

const spec = (id: string, status: IntegrationSpec["status"], departments: IntegrationSpec["departments"] = ["sales"]) =>
  ({ ...INTEGRATIONS[0]!, id, name: `${id} name`, status, departments }) as IntegrationSpec;
const catalog = [spec("alpha", "built"), spec("beta", "planned"), spec("reasoning", "built", [])];
const live = (c: IntegrationSpec) => ({ ...c, status: "built" as const, liveCheckedOn: "2026-11-01" });
const milestone = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  name: "First",
  value: "Gives value.",
  target: "2026-11",
  items: [{ name: "Thing", done: true }, { integration: "beta" }],
  ...over,
});

describe("README progress", () => {
  it("matches docs/milestones.json and the catalog; run npm run progress:write when this fails", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(renderReadme(readme, parseMilestones(JSON.parse(readFileSync(MILESTONES, "utf8")), INTEGRATIONS), INTEGRATIONS)).toBe(readme);
  });

  it("marks an integration item done only once it is built and checked live", () => {
    const out = renderProgress(parseMilestones({ milestones: [milestone()] }, catalog), catalog);
    expect(out).toContain("| First | Gives value. | █████░░░░░ 50% (0 of 1 built, 0 checked live) | Nov 2026 |");
    expect(out).toContain("**Roadmap:** 1 of 2 items done. An integration counts as done once it has run against a real or sandbox account, not when its tests pass.");
    expect(out).toContain("- **First** (target Nov 2026): beta name");
    const built = catalog.map((c) => (c.id === "beta" ? { ...c, status: "built" as const } : c));
    const waiting = renderProgress(parseMilestones({ milestones: [milestone()] }, built), built);
    expect(waiting).toContain("| █████░░░░░ 50% (1 of 1 built, 0 checked live) | Nov 2026 |");
    expect(waiting).toContain("- **First** (target Nov 2026): check live: beta name");
    const checked = built.map((c) => (c.id === "beta" ? live(c) : c));
    const done = renderProgress(parseMilestones({ milestones: [milestone()] }, checked), checked);
    expect(done).toContain("██████████ 100% (1 of 1 built, 1 checked live) | Done |");
    expect(done).toContain("### Up next\n\nEvery milestone is done.");
  });

  it("lists open items before the built ones waiting on a live check, and leaves the counts off a milestone with no integrations", () => {
    const cat = [spec("alpha", "built"), spec("beta", "planned"), spec("gamma", "built"), spec("delta", "planned"), live(spec("eps", "built"))];
    const m = milestone({ items: [{ integration: "alpha" }, { name: "Plain", done: false }, { integration: "beta" }, { integration: "eps" }, { integration: "gamma" }, { integration: "delta" }] });
    const out = renderProgress(parseMilestones({ milestones: [m, milestone({ id: "m2", name: "Second", items: [{ name: "Open", done: false }] })] }, cat), cat);
    expect(out).toContain("(target Nov 2026): Plain; beta name; delta name; check live: alpha name, gamma name");
    expect(out).toContain("| ██░░░░░░░░ 17% (3 of 5 built, 1 checked live) |");
    expect(out).toContain("| Second | Gives value. | ░░░░░░░░░░ 0% | Nov 2026 |");
    expect(out).toContain("(target Nov 2026): Open\n");
  });

  it("does not count a live date on a connector that isn't built", () => {
    const odd = [...catalog, { ...spec("gamma", "planned"), liveCheckedOn: "2026-11-01" }];
    const out = renderProgress(parseMilestones({ milestones: [milestone({ items: [{ integration: "gamma" }] })] }, odd), odd);
    expect(out).toContain("░░░░░░░░░░ 0% (0 of 1 built, 0 checked live)");
    expect(out).toContain("0 have been checked live so far.");
  });

  it("does not count a deferred integration as done", () => {
    const deferred = [...catalog, spec("gamma", "deferred")];
    const out = renderProgress(parseMilestones({ milestones: [milestone({ items: [{ integration: "gamma" }] })] }, deferred), deferred);
    expect(out).toContain("░░░░░░░░░░ 0%");
  });

  it("counts only data sources in the catalog totals, built and checked live", () => {
    const out = renderProgress(parseMilestones({ milestones: [milestone()] }, catalog), catalog);
    expect(out).toContain("**Integrations:** 1 of the 2 systems in the catalog are built and tested against mocks made from each vendor's docs. 0 have been checked live so far.");
    const one = [live(catalog[0]!), catalog[1]!, live(catalog[2]!)];
    expect(renderProgress(parseMilestones({ milestones: [milestone()] }, one), one)).toContain("1 has been checked live so far.");
    const two = [live(catalog[0]!), live(catalog[1]!)];
    expect(renderProgress(parseMilestones({ milestones: [milestone()] }, two), two)).toContain("2 of the 2 systems in the catalog are built and tested against mocks made from each vendor's docs. 2 have been checked live so far.");
  });

  it("lists the three nearest unfinished milestones, nearest target first", () => {
    const ms = ["2027-03", "2026-12", "2027-01", "2026-11", "2026-10"].map((target, i) =>
      milestone({ id: `m${i}`, name: `M${i}`, target, items: [{ name: `open ${i}`, done: false }] }),
    );
    ms[4] = milestone({ id: "m4", name: "M4", target: "2026-10", items: [{ name: "shipped", done: true }] });
    const next = renderProgress(parseMilestones({ milestones: ms }, catalog), catalog).split("### Up next")[1]!;
    expect(next.match(/\*\*M\d\*\*/g)).toEqual(["**M3**", "**M1**", "**M2**"]);
    expect(next).toContain("open 3");
  });

  it("uses a custom name for an integration item when given", () => {
    const out = renderProgress(parseMilestones({ milestones: [milestone({ items: [{ integration: "beta", name: "Custom" }] })] }, catalog), catalog);
    expect(out).toContain("): Custom");
  });

  it("draws a ten-step bar", () => {
    expect(bar(0)).toBe("░".repeat(10));
    expect(bar(57)).toBe("██████░░░░");
    expect(bar(100)).toBe("█".repeat(10));
  });

  it.each([
    [null, "non-empty milestones"],
    [{ milestones: [] }, "non-empty milestones"],
    [{ milestones: [milestone({ value: "" })] }, "needs value"],
    [{ milestones: [milestone(), milestone()] }, "repeats id m1"],
    [{ milestones: [milestone({ target: "2026-13" })] }, "YYYY-MM"],
    [{ milestones: [milestone({ target: "Nov 2026" })] }, "YYYY-MM"],
    [{ milestones: [milestone({ items: [] })] }, "at least one item"],
    [{ milestones: [milestone({ items: [{ integration: "nope" }] })] }, "not in the catalog"],
    [{ milestones: [milestone({ items: [{ integration: "alpha", done: false }] })] }, "takes done from the catalog"],
    [{ milestones: [milestone({ items: [{ name: "No done flag" }] })] }, "a name and done"],
    [{ milestones: [milestone({ items: [{ done: true }] })] }, "a name and done"],
  ])("rejects a bad milestones file (%#)", (json, message) => {
    expect(() => parseMilestones(json, catalog)).toThrow(ProgressError);
    expect(() => parseMilestones(json, catalog)).toThrow(message);
  });

  it("lists every built system that feeds a department, with its first capability and the departments it feeds", () => {
    const withCaps = [
      { ...spec("alpha", "built", ["sales", "custom_orders"]), capabilities: ["Reads | pipes and a \\| slash", "Second"] },
      spec("beta", "planned"),
      { ...spec("reasoning", "built", []), capabilities: ["Not a data source"] },
      { ...spec("gamma", "built", ["finance"]), capabilities: undefined, note: "Only a note" },
    ] as IntegrationSpec[];
    expect(renderConnected(withCaps).split("\n")).toEqual([
      CONNECTED_START,
      "<!-- Generated from the integration catalog by npm run progress:write. Edit the catalog, not this block. -->",
      "",
      "| System | What the business gets | Feeds |",
      "| --- | --- | --- |",
      "| alpha name | Reads \\| pipes and a \\\\\\| slash | Sales, Custom orders |",
      "| gamma name | Only a note | Finance |",
      CONNECTED_END,
    ]);
    expect(renderConnected([spec("beta", "planned")])).toContain("Nothing is built yet.");
  });

  it("keeps both generated blocks current and leaves the rest of the README alone", () => {
    const readme = `intro\n${START}\nold\n${END}\nmiddle\n${CONNECTED_START}\nold\n${CONNECTED_END}\nend`;
    const out = renderReadme(readme, parseMilestones({ milestones: [milestone()] }, catalog), catalog);
    expect(out.startsWith("intro\n<!-- progress:start -->")).toBe(true);
    expect(out).toContain(`${END}\nmiddle\n${CONNECTED_START}`);
    expect(out).toContain("| alpha name |");
    expect(out.endsWith(`${CONNECTED_END}\nend`)).toBe(true);
    expect(() => renderReadme(`${START}\n${END}`, parseMilestones({ milestones: [milestone()] }, catalog), catalog)).toThrow(CONNECTED_START);
  });

  it("replaces only the marked block", () => {
    expect(replaceBlock(`a\n<!-- x -->\nold\n<!-- y -->\nb`, "NEW", "<!-- x -->", "<!-- y -->")).toBe("a\nNEW\nb");
    expect(replaceProgress(`a\n${START}\nold\n${END}\nb`, "NEW")).toBe("a\nNEW\nb");
  });

  it.each([["no markers"], [`${END} before ${START}`], [`${START}${END}${START}${END}`]])("refuses a README without exactly one block: %s", (readme) => {
    expect(() => replaceProgress(readme, "x")).toThrow(ProgressError);
  });
});
