import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INTEGRATIONS, type IntegrationSpec } from "../packages/core/src/index.js";
import { CONNECTED_END, CONNECTED_START, END, MILESTONES, ProgressError, START, bar, parseMilestones, renderConnected, renderProgress, renderReadme, replaceBlock, replaceProgress } from "./progress.js";

const spec = (id: string, status: IntegrationSpec["status"], departments: IntegrationSpec["departments"] = ["sales"]) =>
  ({ ...INTEGRATIONS[0]!, id, name: `${id} name`, status, departments }) as IntegrationSpec;
const catalog = [spec("alpha", "built"), spec("beta", "planned"), spec("reasoning", "built", [])];
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

  it("marks an integration item done only when the catalog says built", () => {
    const out = renderProgress(parseMilestones({ milestones: [milestone()] }, catalog), catalog);
    expect(out).toContain("| First | Gives value. | █████░░░░░ 50% | Nov 2026 |");
    expect(out).toContain("1 of 2 roadmap items done");
    expect(out).toContain("- **First** (target Nov 2026): beta name");
    const built = catalog.map((c) => (c.id === "beta" ? { ...c, status: "built" as const } : c));
    const done = renderProgress(parseMilestones({ milestones: [milestone()] }, built), built);
    expect(done).toContain("██████████ 100% | Done |");
    expect(done).toContain("### Up next\n\nEvery milestone is done.");
  });

  it("does not count a deferred integration as done", () => {
    const deferred = [...catalog, spec("gamma", "deferred")];
    const out = renderProgress(parseMilestones({ milestones: [milestone({ items: [{ integration: "gamma" }] })] }, deferred), deferred);
    expect(out).toContain("░░░░░░░░░░ 0%");
  });

  it("counts only data sources in the catalog total", () => {
    const out = renderProgress(parseMilestones({ milestones: [milestone()] }, catalog), catalog);
    expect(out).toContain("1 of the 2 systems in the integration catalog are connected");
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
      { ...spec("alpha", "built", ["sales", "custom_orders"]), capabilities: ["Reads | pipes", "Second"] },
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
      "| alpha name | Reads \\| pipes | Sales, Custom orders |",
      "| gamma name | Only a note | Finance |",
      CONNECTED_END,
    ]);
    expect(renderConnected([spec("beta", "planned")])).toContain("Nothing is connected yet.");
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
