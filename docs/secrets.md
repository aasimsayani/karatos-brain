# Secrets

Brain A keeps a value-free list of every secret and setting an instance needs in [`secrets/manifest.json`](../secrets/manifest.json). Its format is defined by a JSON Schema in [`secrets/manifest.schema.json`](../secrets/manifest.schema.json), so any language or agent can read it.

Each entry says:

- what the value is for, and whether it is a **secret** (never shown) or plain **config**
- when it's needed: always (`core`, `instance`), for migrations, or only once an integration is turned on (`integration:shopify`)
- plain-language steps to get it, with a link to the provider's docs
- a pattern to check it against, so a half-copied key is caught immediately
- whether a machine should **generate** it instead of asking a person
- how often to rotate it

## Commands

| Command | What it does |
| --- | --- |
| `npm run secrets:plan` | Shows what's ready, missing, invalid or will be generated. Never prints values. |
| `npm run secrets:plan -- --json` | The same plan as JSON, for another agent or script to act on |
| `npm run secrets:setup` | Generates what it can, then asks for each missing value one at a time with instructions, hiding secret input. Writes `.env.local` readable only by you. |
| `npm run secrets:setup -- --generate-only` | Generates values without prompting. Safe for agents and CI. |

Both commands take `--env-file <path>` to work on another file, and `--purposes core,instance,migrations` to choose which purposes count.

## For AI agents

An agent setting up an instance should:

1. Read `secrets/manifest.json`, or run `npm run secrets:plan -- --json`.
2. Run `npm run secrets:setup -- --generate-only` for everything a machine can create.
3. For each item still `missing`, ask the human for that one value, quoting its `howToGet` steps. Never invent, guess or reuse a value from another client.
4. Write values only to the env file or the host's secret store. Never to git, chat, docs, tickets or logs.
5. Re-run `secrets:plan` until it reports ready.

## Where secrets live

| Place | Used for |
| --- | --- |
| `.env.local` on the owner's machine | Local runs and migrations. Git-ignored and `chmod 600`. |
| The host's secret store | The running instance |
| A password manager | The human copy of anything that can't be regenerated, such as the database password |

Never store secrets in this repo, a private instance repo, Google Docs or chat. CI runs `npm run secrets:scan` on every push to catch mistakes.

## Adding a new secret

Add an entry to `secrets/manifest.json` in the same PR that starts reading the value. A test fails if the runtime reads a setting the manifest doesn't document.
