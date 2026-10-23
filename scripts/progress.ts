import type { IntegrationSpec } from "../packages/core/src/index.js";

// Renders the README's progress section from docs/milestones.json and the integration catalog.
// npm run progress:write regenerates it; a test fails when the README falls behind.

export const MILESTONES = "docs/milestones.json";
export const START = "<!-- progress:start -->";
export const END = "<!-- progress:end -->";
export const CONNECTED_START = "<!-- connected:start -->";
export const CONNECTED_END = "<!-- connected:end -->";

export interface MilestoneItem {
  name?: string;
  done?: boolean;
  integration?: string;
}

export interface Milestone {
  id: string;
  name: string;
  value: string;
  target: string;
  items: MilestoneItem[];
}

export class ProgressError extends Error {}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function parseMilestones(json: unknown, catalog: readonly IntegrationSpec[]): Milestone[] {
  const list = (json as { milestones?: unknown } | null)?.milestones;
  if (!Array.isArray(list) || list.length === 0) throw new ProgressError("milestones.json needs a non-empty milestones list");
  const ids = new Set<string>();
  return list.map((raw, i) => {
    const m = raw as Partial<Milestone>;
    const where = `milestone ${i + 1}`;
    for (const key of ["id", "name", "value", "target"] as const) {
      if (typeof m[key] !== "string" || !m[key]) throw new ProgressError(`${where} needs ${key}`);
    }
    if (ids.has(m.id!)) throw new ProgressError(`${where} repeats id ${m.id}`);
    ids.add(m.id!);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m.target!)) throw new ProgressError(`${m.id} target must be YYYY-MM`);
    if (!Array.isArray(m.items) || m.items.length === 0) throw new ProgressError(`${m.id} needs at least one item`);
    for (const item of m.items) {
      if (item.integration !== undefined) {
        if (item.done !== undefined) throw new ProgressError(`${m.id}: ${item.integration} takes done from the catalog`);
        if (!catalog.some((c) => c.id === item.integration)) throw new ProgressError(`${m.id}: ${item.integration} is not in the catalog`);
      } else if (typeof item.name !== "string" || !item.name || typeof item.done !== "boolean") {
        throw new ProgressError(`${m.id}: an item needs a name and done, or an integration id`);
      }
    }
    return m as Milestone;
  });
}

function resolve(item: MilestoneItem, catalog: readonly IntegrationSpec[]): { name: string; done: boolean } {
  if (item.integration === undefined) return { name: item.name!, done: item.done! };
  const spec = catalog.find((c) => c.id === item.integration)!;
  return { name: item.name ?? spec.name, done: spec.status === "built" };
}

export function bar(percent: number): string {
  const filled = Math.round(percent / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

const month = (target: string) => `${MONTHS[Number(target.slice(5)) - 1]} ${target.slice(0, 4)}`;

export function renderProgress(milestones: readonly Milestone[], catalog: readonly IntegrationSpec[]): string {
  const rows = milestones.map((m) => {
    const items = m.items.map((i) => resolve(i, catalog));
    const done = items.filter((i) => i.done).length;
    return { m, items, done, percent: Math.round((done / items.length) * 100) };
  });
  const done = rows.reduce((n, r) => n + r.done, 0);
  const total = rows.reduce((n, r) => n + r.items.length, 0);
  const sources = catalog.filter((c) => c.departments.length > 0);
  const connected = sources.filter((c) => c.status === "built").length;
  const next = rows
    .filter((r) => r.percent < 100)
    .sort((a, b) => a.m.target.localeCompare(b.m.target))
    .slice(0, 3)
    .map((r) => `- **${r.m.name}** (target ${month(r.m.target)}): ${r.items.filter((i) => !i.done).map((i) => i.name).join("; ")}`);
  const lines = [
    START,
    "<!-- Generated from docs/milestones.json and the integration catalog by npm run progress:write. Edit those, not this block. -->",
    "",
    `**Overall: ${Math.round((done / total) * 100)}% complete**, ${done} of ${total} roadmap items done. ${connected} of the ${sources.length} systems in the integration catalog are connected.`,
    "",
    "| Milestone | What it gives a jeweler | Progress | Target |",
    "| --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r.m.name} | ${r.m.value} | ${bar(r.percent)} ${r.percent}% | ${r.percent === 100 ? "Done" : month(r.m.target)} |`),
    "",
    "### Up next",
    "",
    ...(next.length ? next : ["Every milestone is done."]),
    END,
  ];
  return lines.join("\n");
}

const label = (id: string) => id.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/**
 * The README's "Connected today" table: every built system, what it gives the
 * business (its first catalog capability) and the departments it feeds, so
 * the README names exactly what is built.
 */
export function renderConnected(catalog: readonly IntegrationSpec[]): string {
  const built = catalog.filter((c) => c.status === "built" && c.departments.length > 0);
  const lines = [
    CONNECTED_START,
    "<!-- Generated from the integration catalog by npm run progress:write. Edit the catalog, not this block. -->",
    "",
    ...(built.length
      ? [
          "| System | What the business gets | Feeds |",
          "| --- | --- | --- |",
          ...built.map((c) => `| ${c.name} | ${(c.capabilities?.[0] ?? c.note ?? "").replace(/\|/g, "\\|")} | ${c.departments.map(label).join(", ")} |`),
        ]
      : ["Nothing is connected yet."]),
    CONNECTED_END,
  ];
  return lines.join("\n");
}

/** Replaces the one block between `startMark` and `endMark`. */
export function replaceBlock(readme: string, block: string, startMark = START, endMark = END): string {
  const start = readme.indexOf(startMark);
  const end = readme.indexOf(endMark);
  if (start < 0 || end < start || readme.indexOf(startMark, start + 1) >= 0) throw new ProgressError(`README needs exactly one ${startMark} ... ${endMark} block`);
  return readme.slice(0, start) + block + readme.slice(end + endMark.length);
}

export function replaceProgress(readme: string, block: string): string {
  return replaceBlock(readme, block);
}

/** The README with both generated blocks current. */
export function renderReadme(readme: string, milestones: readonly Milestone[], catalog: readonly IntegrationSpec[]): string {
  const withProgress = replaceProgress(readme, renderProgress(milestones, catalog));
  return replaceBlock(withProgress, renderConnected(catalog), CONNECTED_START, CONNECTED_END);
}
