# Contributing

Read [AGENTS.md](AGENTS.md) and the README's "Working on the repo" notes first. This page covers the one task that happens most often: adding a connector.

## Adding a connector

Each connector keeps everything about itself in its own files, named after its catalog id (`<id>` below, e.g. `hubspot`). Every list that names all the connectors is generated from those files, so two connector PRs never edit the same lines and merge without conflicts.

### Files you create

| File | What goes in it |
| --- | --- |
| `packages/connectors/src/<id>/` | The connector, with an `index.ts` exporting it |
| `packages/connectors/test/<id>.test.ts` | Its unit and contract tests |
| `packages/core/src/catalog/<id>.ts` | Its catalog fields once built: `status: "built"`, `note`, `capabilities`, and any row field it settles while being built (`settings`, `signIn`, `testWith`, `departments`). They take the place of the row's own in `packages/core/src/integrations.ts`, which you leave alone |
| `packages/server/src/connectors/<id>.ts` | Its factory: the settings it needs and how the scheduled runner builds it |
| `packages/server/test/connectors/<id>.test.ts` | The factory's tests: what it reports missing, and that it builds from settings |
| `scripts/sandbox-checks/<id>.ts` and `<id>.test.ts` | Its nightly sandbox check, when the vendor has a free sandbox. Its `credentials` are passed to the nightly job for you |
| `packages/testkit/src/mocks/<id>.ts` | A mock built from the vendor's docs, when there's nothing else to test against yet. Its default export says what it `covers`, its `watchPages` and its `docMocks()` |
| `secrets/manifest/<id>.json` | Its settings: `{ "integration": "<id>", "uses": [...], "entries": [...] }`. Each entry is `requiredFor: ["integration:<id>"]` |
| `docs/integrations/<id>.md` | Its section of [docs/integrations.md](docs/integrations.md), starting with `### <Name>` |
| `changelog.d/<branch>.md` | Its changelog fragment |

A setting several connectors share, such as one key for hashing customer references, goes once in `secrets/manifest/shared.json` with `requiredFor` empty (or only `instance` and the like). Each connector that needs it lists its name in `uses` in its own manifest file, and the generator adds `integration:<id>` for each one. So two connectors can need the same setting without touching the same file. Settings for the instance itself are in `secrets/manifest/instance.json`.

### Then run

```sh
npm run registry:write
```

It writes, sorted and marked "generated, do not edit":

- the export lists: `packages/connectors/src/index.ts`, `packages/core/src/catalog/index.ts`, `packages/server/src/connectors/index.ts`, `packages/testkit/src/mocks/index.ts` (with `allDocMocks()`) and `scripts/sandbox-checks/index.ts`;
- `secrets/manifest.json`, merged from `secrets/manifest/`;
- the `SANDBOX_*` lines in `.github/workflows/sandbox-run.yml`;
- the catalog tables, the mock list and the connector sections in `docs/integrations.md`;
- the README's progress section.

Commit what it writes. `npm run registry:check`, and a test in `scripts/registry.test.ts` that CI runs, fail when a generated file is out of date or was edited by hand. The same tests check that every built catalog entry has its factory, its factory test, its docs section and its settings in the manifest, a sandbox check when its vendor has a sandbox, and a mock when it has neither a sandbox nor sample files. Counts and lists in tests come from the catalog, so no test needs a new line for your connector.

### When main moves

After a PR merges, `scripts/sync-open-prs.sh` merges main into every other open PR. A conflict in a generated file is settled by running `npm run registry:write` again, so only a conflict in a connector's own files or in hand-written code is left for a person.

### What is still shared

- `packages/core/src/integrations.ts` keeps one row per system with what it is and how it can be reached. A connector PR doesn't edit it: its own catalog file overrides the row's fields. Add a row only for a new system.
- Generic tests that use a few connectors as examples (`packages/server/test/sync.test.ts`) don't list them all and need no edit.
- The prose in `docs/integrations.md` outside the generated blocks, and the "Systems by department" table, change only when the catalog's shape does.
