# Notes for AI agents working in this repo

This repo is **public**. Treat everything you write here as published.

- Never commit secrets, customer data, bank statements or anything specific to one client. Client specifics belong in that client's private instance repo, and values belong in a secret store.
- Secrets: follow [docs/secrets.md](docs/secrets.md). `secrets/manifest.json` is the source of truth for what an instance needs. Use `npm run secrets:plan -- --json` to see what's missing, and never print a secret value.
- Architecture: read [docs/architecture/overview.md](docs/architecture/overview.md). No layer may be bypassed, and every recommendation carries provenance and a degraded flag.
- Before pushing, run `npm run secrets:scan`, `npm run typecheck` and `npm run test:coverage`. Coverage must stay above the thresholds in `vitest.config.ts`.
- Every behavior change needs a test. Database changes need a migration plus a test that runs it against PGlite.
- Update `CHANGELOG.md` and the relevant doc in the same PR.
