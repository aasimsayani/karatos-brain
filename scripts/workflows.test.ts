import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Supply-chain and injection rules for GitHub Actions. A tag like `@v4` can
 * be moved to new code at any time, so every action is pinned to a full
 * commit SHA (Dependabot keeps the pins current).
 */
const dir = new URL("../.github/workflows/", import.meta.url);
const workflows = readdirSync(dir)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .map((name) => ({ name, text: readFileSync(new URL(name, dir), "utf8") }));

describe("GitHub Actions workflows", () => {
  it("are all checked", () => {
    expect(workflows.map((w) => w.name)).toEqual(expect.arrayContaining(["ci.yml", "codeql.yml"]));
  });

  it("pin every action to a full commit SHA, with the version it was in a comment", () => {
    const unpinned = workflows.flatMap(({ name, text }) =>
      [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)]
        .filter((m) => !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(m[1]!) || !/#\s*v\d+\.\d+\.\d+/.test(m[2]!))
        .map((m) => `${name}: ${m[1]}`),
    );
    expect(unpinned).toEqual([]);
  });

  it("start every workflow at read-only token permissions", () => {
    for (const { name, text } of workflows) expect(text, name).toMatch(/^permissions:\n\s+contents: read$/m);
    for (const { name, text } of workflows) expect(text, name).not.toMatch(/write-all|permissions:\s*write/);
  });

  it("never run untrusted pull request code with secrets", () => {
    for (const { name, text } of workflows) expect(text, name).not.toContain("pull_request_target");
  });

  it("never paste event text into a shell, where a crafted title or branch name could run as code", () => {
    for (const { name, text } of workflows) {
      const runs = [...text.matchAll(/^\s*(?:-\s*)?run:\s*(.*(?:\n(?!\s*-\s|\s*\w+:).*)*)/gm)].map((m) => m[1]!);
      expect(runs.filter((r) => /\$\{\{\s*github\.(event|head_ref)/.test(r)), name).toEqual([]);
    }
  });

  it("don't leave the job token in the checked-out repo", () => {
    for (const { name, text } of workflows) {
      const checkouts = text.split("\n").flatMap((line, i, lines) => (/uses: actions\/checkout@/.test(line) ? [lines.slice(i, i + 4).join("\n")] : []));
      for (const step of checkouts) expect(step, name).toContain("persist-credentials: false");
    }
  });
});

describe("Dependabot", () => {
  const config = readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8");
  it("watches npm, the pinned actions and both Docker images", () => {
    for (const ecosystem of ["npm", "github-actions", "docker"]) expect(config).toContain(`package-ecosystem: ${ecosystem}`);
    expect(config).toContain("directories: [/, /site]");
  });
});
