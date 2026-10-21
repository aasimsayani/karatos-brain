# Changelog fragments

Each PR adds one file here instead of editing `CHANGELOG.md`, so open PRs never conflict over the same lines.

- Name it after your branch: `changelog.d/<branch>.md` (lowercase, dashes for anything else).
- Write one `- ` bullet per change, in the same style as `CHANGELOG.md`. Indent a line two spaces to continue the bullet above.
- `npm run changelog:check` runs in CI on every PR. It fails when the PR edits `CHANGELOG.md` directly, adds no fragment, or a fragment is malformed.
- Dependabot PRs (`dependabot/...` branches) that change only package manifests, the lockfile, Dockerfiles or workflow files need no fragment. Anything else they change still needs one.
- At release, `npm run changelog:collect` on a `release/<version>` branch folds every fragment into the Unreleased section and deletes the fragment files.
- After a PR merges, `scripts/sync-open-prs.sh` brings the base branch into every other open PR. It merges rather than rebases, so nothing is force-pushed. It moves any lines a PR still adds to `CHANGELOG.md` into that PR's fragment, and it reports any other conflict for a person to resolve. A branch is pushed only after the secrets scan, typecheck, coverage and changelog checks pass.
