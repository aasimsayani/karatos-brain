import { describe, expect, it } from "vitest";
import { ChangelogError, checkPullRequest, collectFragments, fragmentName, parseFragment, safeName } from "./changelog.js";

const problemsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ChangelogError) return error.problems;
    throw error;
  }
  return [];
};

describe("fragmentName", () => {
  it("names fragment files and ignores the README and other paths", () => {
    expect(fragmentName("changelog.d/doc-mocks.md")).toBe("doc-mocks");
    expect(fragmentName("changelog.d/README.md")).toBeNull();
    expect(fragmentName("changelog.d/sub/x.md")).toBeNull();
    expect(fragmentName("docs/x.md")).toBeNull();
  });
});

describe("parseFragment", () => {
  it("reads bullets and joins indented continuation lines", () => {
    expect(parseFragment("x", "- One\n  continued\n\n- Two\n")).toEqual(["- One continued", "- Two"]);
  });

  it("refuses an empty fragment, stray text and conflict markers", () => {
    expect(problemsOf(() => parseFragment("x", "\n"))).toEqual(["changelog.d/x.md: it has no entries"]);
    expect(problemsOf(() => parseFragment("x", "Not a bullet\n<<<<<<< HEAD\n- ok"))[0]).toBe(
      'changelog.d/x.md: line 1 must start with "- "; line 2 is a merge conflict marker',
    );
  });
});

describe("checkPullRequest", () => {
  it("passes a PR that adds a valid fragment", () => {
    expect(problemsOf(() => checkPullRequest("doc-mocks", [{ status: "A", path: "changelog.d/doc-mocks.md" }], { "doc-mocks": "- Mocks" }))).toEqual([]);
  });

  it("refuses edits to CHANGELOG.md and a missing fragment, naming the file to add", () => {
    expect(problemsOf(() => checkPullRequest("Feature/Thing", [{ status: "M", path: "CHANGELOG.md" }], {}))).toEqual([
      "CHANGELOG.md is edited directly; put the entry in changelog.d/feature-thing.md instead",
      "no changelog entry; add changelog.d/feature-thing.md",
    ]);
  });

  it("does not count a deleted fragment, and reports a broken one", () => {
    expect(problemsOf(() => checkPullRequest("a", [{ status: "D", path: "changelog.d/a.md" }], {}))).toEqual(["no changelog entry; add changelog.d/a.md"]);
    expect(problemsOf(() => checkPullRequest("a", [{ status: "M", path: "changelog.d/a.md" }], { a: "oops" }))).toEqual([
      'changelog.d/a.md: line 1 must start with "- "',
    ]);
  });

  it("lets Dependabot bump dependency files without a fragment, but nothing else", () => {
    const bump = [
      { status: "M", path: "package.json" },
      { status: "M", path: "package-lock.json" },
      { status: "M", path: "packages/server/package.json" },
      { status: "M", path: "site/Dockerfile" },
      { status: "M", path: "Dockerfile" },
      { status: "M", path: ".github/workflows/ci.yml" },
    ];
    expect(problemsOf(() => checkPullRequest("dependabot/npm_and_yarn/zod-4.6.7", bump, {}))).toEqual([]);
    const missing = ["no changelog entry; add changelog.d/dependabot-npm_and_yarn-zod-4.6.7.md"];
    expect(problemsOf(() => checkPullRequest("dependabot/npm_and_yarn/zod-4.6.7", [...bump, { status: "M", path: "packages/server/src/app.ts" }], {}))).toEqual(missing);
    expect(problemsOf(() => checkPullRequest("dependabot/npm_and_yarn/zod-4.6.7", [], {}))).toEqual(missing);
    expect(problemsOf(() => checkPullRequest("feature/zod", bump, {}))).toEqual(["no changelog entry; add changelog.d/feature-zod.md"]);
    expect(problemsOf(() => checkPullRequest("dependabot/x", [{ status: "M", path: "CHANGELOG.md" }], {}))).toEqual([
      "CHANGELOG.md is edited directly; put the entry in changelog.d/dependabot-x.md instead",
      "no changelog entry; add changelog.d/dependabot-x.md",
    ]);
    for (const path of ["evil/package.json.ts", "site/package-data.json", "docs/Dockerfile.md", ".github/workflows/../../src/a.yml"]) {
      expect(problemsOf(() => checkPullRequest("dependabot/x", [{ status: "M", path }], {}))).toHaveLength(1);
    }
  });

  it("lets release branches fold fragments into CHANGELOG.md", () => {
    expect(problemsOf(() => checkPullRequest("release/0.6.0", [{ status: "M", path: "CHANGELOG.md" }, { status: "D", path: "changelog.d/a.md" }], {}))).toEqual([]);
  });
});

describe("safeName", () => {
  it("turns any branch into a file name", () => {
    expect(safeName("claude/Fix CI!")).toBe("claude-fix-ci");
    expect(safeName("///")).toBe("change");
  });
});

describe("collectFragments", () => {
  const changelog = "# Changelog\n\n## Unreleased\n\n- Old one\n\n- Old two\n\n## 0.1.0\n\n- First\n";

  it("puts fragment entries first and tidies the section into one list", () => {
    expect(collectFragments(changelog, [{ name: "a", text: "- New\n" }, { name: "b", text: "- Old one\n- New\n" }])).toBe(
      "# Changelog\n\n## Unreleased\n\n- New\n- Old one\n- Old two\n\n## 0.1.0\n\n- First\n",
    );
  });

  it("handles an Unreleased section at the end of the file", () => {
    expect(collectFragments("# C\n\n## Unreleased\n", [{ name: "a", text: "- New" }])).toBe("# C\n\n## Unreleased\n\n- New\n");
  });

  it("refuses a changelog without Unreleased or with leftover conflict markers", () => {
    expect(problemsOf(() => collectFragments("# C\n", []))).toEqual(['CHANGELOG.md has no "## Unreleased" section']);
    expect(problemsOf(() => collectFragments("## Unreleased\n<<<<<<< HEAD\n", []))).toEqual(["CHANGELOG.md still has merge conflict markers in Unreleased"]);
  });
});
