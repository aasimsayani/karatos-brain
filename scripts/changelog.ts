/**
 * Changelog fragments. Each PR adds its own file in `changelog.d/` instead of
 * editing CHANGELOG.md, so open PRs never conflict over the same lines. The
 * fragments are folded into CHANGELOG.md's Unreleased section at release time.
 */

export const FRAGMENT_DIR = "changelog.d";
export const CHANGELOG = "CHANGELOG.md";

const CONFLICT_MARKER = /^(<{7}|={7}|>{7})( |$)/;

/** A fragment's path, or null when the path is not a fragment (the README, other folders). */
export function fragmentName(path: string): string | null {
  const match = new RegExp(`^${FRAGMENT_DIR}/([a-z0-9][a-z0-9._-]*)\\.md$`).exec(path);
  return match && match[1] !== "README" ? match[1]! : null;
}

/** A fragment's entries: `- ` bullets, with lines indented two spaces continuing the bullet above. */
export function parseFragment(name: string, text: string): string[] {
  const entries: string[] = [];
  const problems: string[] = [];
  text.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    if (CONFLICT_MARKER.test(line)) problems.push(`line ${index + 1} is a merge conflict marker`);
    else if (line.startsWith("- ")) entries.push(line.trimEnd());
    else if (line.startsWith("  ") && entries.length) entries[entries.length - 1] += ` ${line.trim()}`;
    else problems.push(`line ${index + 1} must start with "- "`);
  });
  if (!entries.length && !problems.length) problems.push("it has no entries");
  if (problems.length) throw new ChangelogError([`${FRAGMENT_DIR}/${name}.md: ${problems.join("; ")}`]);
  return entries;
}

export class ChangelogError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.problems = problems;
    this.name = "ChangelogError";
  }
}

export interface ChangedFile {
  /** git's status letter: A, M, D, R... */
  status: string;
  path: string;
}

/** Files a Dependabot update may change: package manifests, the lockfile, Dockerfiles and workflow files. */
const DEPENDENCY_FILE = /^(?:(?:[\w.-]+\/)*package(?:-lock)?\.json|(?:[\w.-]+\/)*Dockerfile|\.github\/workflows\/[\w.-]+\.ya?ml)$/;

/**
 * Checks a PR's changes: it adds or edits a fragment, every fragment it
 * touches parses, and it leaves CHANGELOG.md alone. Release branches
 * (`release/...`) are the exception: they fold the fragments in. Dependabot
 * branches (`dependabot/...`) that only change dependency files need no
 * fragment, since a version bump is not a change anyone reads about.
 */
export function checkPullRequest(branch: string, changed: readonly ChangedFile[], fragments: Readonly<Record<string, string>>): void {
  const problems: string[] = [];
  const release = branch.startsWith("release/");
  if (!release && changed.some((f) => f.path === CHANGELOG)) {
    problems.push(`${CHANGELOG} is edited directly; put the entry in ${FRAGMENT_DIR}/${safeName(branch)}.md instead`);
  }
  const touched = changed.filter((f) => !f.status.startsWith("D") && fragmentName(f.path));
  const dependencyBump = branch.startsWith("dependabot/") && changed.length > 0 && changed.every((f) => DEPENDENCY_FILE.test(f.path));
  if (!release && !dependencyBump && !touched.length) problems.push(`no changelog entry; add ${FRAGMENT_DIR}/${safeName(branch)}.md`);
  for (const file of touched) {
    const name = fragmentName(file.path)!;
    try {
      parseFragment(name, fragments[name] ?? "");
    } catch (error) {
      problems.push(...(error as ChangelogError).problems);
    }
  }
  if (problems.length) throw new ChangelogError(problems);
}

/** The fragment file name for a branch: lowercase, with anything else turned into dashes. */
export function safeName(branch: string): string {
  return branch.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|-+$/g, "") || "change";
}

/**
 * Folds fragments into the Unreleased section, newest (by name order given)
 * first, and tidies that section into one list without blank lines between
 * entries. Entries already in the section are not repeated.
 */
export function collectFragments(changelog: string, fragments: readonly { name: string; text: string }[]): string {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => /^## Unreleased\s*$/.test(l));
  if (start < 0) throw new ChangelogError([`${CHANGELOG} has no "## Unreleased" section`]);
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end < 0) end = lines.length;

  const existing = lines.slice(start + 1, end).filter((l) => l.trim());
  const conflicts = existing.filter((l) => CONFLICT_MARKER.test(l));
  if (conflicts.length) throw new ChangelogError([`${CHANGELOG} still has merge conflict markers in Unreleased`]);
  const seen = new Set(existing.map((l) => l.trim()));
  const added = fragments.flatMap((f) => parseFragment(f.name, f.text)).filter((e) => !seen.has(e.trim()) && seen.add(e.trim()));

  const section = ["## Unreleased", "", ...added, ...existing, ""];
  return [...lines.slice(0, start), ...section, ...lines.slice(end)].join("\n");
}
