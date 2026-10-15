import { execFileSync } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CHANGELOG, ChangelogError, FRAGMENT_DIR, checkPullRequest, collectFragments, fragmentName, type ChangedFile } from "./changelog.js";

// npm run changelog:check     checks this branch against its base (GITHUB_BASE_REF, else main)
// npm run changelog:collect   folds every fragment into CHANGELOG.md and deletes the fragments

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

async function check(): Promise<void> {
  const base = `origin/${process.env.GITHUB_BASE_REF || "main"}`;
  const branch = process.env.GITHUB_HEAD_REF || git("rev-parse", "--abbrev-ref", "HEAD");
  const changed: ChangedFile[] = git("diff", "--name-status", "--no-renames", `${base}...HEAD`)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split("\t");
      return { status: status!, path: path! };
    });
  const fragments: Record<string, string> = {};
  for (const file of changed) {
    const name = fragmentName(file.path);
    if (name && !file.status.startsWith("D")) fragments[name] = await readFile(file.path, "utf8");
  }
  checkPullRequest(branch, changed, fragments);
  console.log(`changelog ok: ${Object.keys(fragments).map((n) => `${FRAGMENT_DIR}/${n}.md`).join(", ") || "release branch"}`);
}

async function collect(): Promise<void> {
  const names = (await readdir(FRAGMENT_DIR)).map((f) => fragmentName(`${FRAGMENT_DIR}/${f}`)).filter((n): n is string => !!n).sort();
  const fragments = await Promise.all(names.map(async (name) => ({ name, text: await readFile(join(FRAGMENT_DIR, `${name}.md`), "utf8") })));
  await writeFile(CHANGELOG, collectFragments(await readFile(CHANGELOG, "utf8"), fragments));
  await Promise.all(names.map((name) => rm(join(FRAGMENT_DIR, `${name}.md`))));
  console.log(`folded ${names.length} fragment(s) into ${CHANGELOG}`);
}

const command = process.argv[2];
try {
  if (command === "check") await check();
  else if (command === "collect") await collect();
  else throw new ChangelogError([`usage: changelog-cli.ts check|collect`]);
} catch (error) {
  console.error(error instanceof ChangelogError ? error.message : error);
  process.exit(1);
}
