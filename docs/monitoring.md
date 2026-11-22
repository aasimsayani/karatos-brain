# Monitoring instances

The instance monitor checks each client instance you support and tells you when something needs attention. It reads only what the [support key](security.md#support-access-without-seeing-data) can reach, `GET /healthz` and `GET /v1/support/status`, so it sees versions, times and counts, never the business's records.

Run it from a private ops repo on a schedule. This public repo has the monitor and a reusable workflow, but no instance list and no schedule: a run here would put instance names in public logs.

## Setting it up

1. **Create a support key for each instance.** Generate one with `npm run secrets:setup -- --generate-only --purposes core,instance,migrations,support`, put it in the host's secret store as `SUPPORT_API_KEY` and restart the instance. See [setting up a new client](deployment/instances.md#setting-up-a-new-client), step 7. Never use `INSTANCE_API_KEY` for monitoring.
2. **Create a private ops repo**, or use one you already have. It holds the instance list and the alerts, so keep it private.
3. **Store each key as a secret in the ops repo** (Settings, Secrets and variables, Actions), one per instance, such as `ACME_SUPPORT_KEY`.
4. **List the instances** in a config file in the ops repo, such as `monitor/instances.json`. The file names the variable that holds each key, never the key:

   ```json
   {
     "thresholds": { "syncStaleHours": 24, "deadLetters": 100 },
     "instances": [
       { "name": "acme", "baseUrl": "https://acme-brain.example.test", "supportKeyEnv": "ACME_SUPPORT_KEY" },
       { "name": "beta", "baseUrl": "https://beta-brain.example.test", "supportKeyEnv": "BETA_SUPPORT_KEY", "thresholds": { "syncStaleHours": 48 } }
     ]
   }
   ```

   `name` is 1 to 64 letters, digits, dots, dashes or underscores, and titles the instance's issue. `baseUrl` must use https (http only for localhost) and carry no user name, password or query string. `supportKeyEnv` is the variable's name in capitals. A field that looks like it holds a key, such as `supportKey`, is turned down so a key never ends up in the file. `timeoutMs` (default 10000, 100 to 120000) sets how long each request may take.

5. **Add a caller workflow** to the ops repo, such as `.github/workflows/monitor.yml`:

   ```yaml
   name: Monitor instances

   on:
     schedule:
       - cron: "*/30 * * * *"
     workflow_dispatch:

   permissions:
     contents: read
     issues: write

   jobs:
     monitor:
       # Pin to a release tag or commit the instances run, not a moving branch.
       uses: aasimsayani/karatos-brain/.github/workflows/instance-monitor.yml@<tag-or-commit>
       with:
         config-file: monitor/instances.json
         open-issues: true
         brain-ref: <tag-or-commit>
       secrets:
         SUPPORT_KEYS: |
           ACME_SUPPORT_KEY=${{ secrets.ACME_SUPPORT_KEY }}
           BETA_SUPPORT_KEY=${{ secrets.BETA_SUPPORT_KEY }}
   ```

   The caller has to grant `issues: write` even with `open-issues: false`, because a called workflow can't ask for more than its caller allows. The workflow's own `GITHUB_TOKEN` files the issues, in the ops repo; it needs no other permission and no personal token.

### The workflow's inputs

| Input | Default | What it does |
| --- | --- | --- |
| `config-file` | | Path to the config file in the calling repo. Only that file is checked out |
| `config` | | The config as JSON, instead of a file |
| `open-issues` | `false` | Keep one issue per instance in the calling repo |
| `expected-migrations` | `false` | Also expect every migration in `brain-ref` to be applied. Turn it on only when `brain-ref` is the release the instances run |
| `brain-ref` | `main` | The release of the monitor to run |
| `SUPPORT_KEYS` (secret) | | One `NAME=key` line per instance, `NAME` being its `supportKeyEnv` |

The workflow masks each key in the log before the check runs, keeps counts and times from the last run in the Actions cache (so it can tell when dead letters grow), writes the report to the job summary, and sets the output `healthy` to `true` or `false`. The job fails when anything needs attention, so a failed run is also an alert by itself.

### Issues

With `open-issues: true`, each instance has at most one open issue, titled `Instance monitor: <name> needs attention` and labeled `instance-monitor`:

- When something goes wrong, the monitor opens the issue with what is wrong and what to do.
- While the same things stay wrong, it leaves the issue alone, so a check every 30 minutes doesn't fill it with comments.
- When what is wrong changes (a new problem, or one of several fixed), it comments with the new list and refreshes the issue's body.
- When the instance is healthy again, it comments and closes the issue. A later problem opens a new one.

An instance taken out of the config keeps any open issue; close it by hand.

## Running it by hand

```bash
export ACME_SUPPORT_KEY=...   # from your password manager; never on the command line
npm run monitor -- --config monitor/instances.json
```

| Option | What it does |
| --- | --- |
| `--config <file>` | The config file. Or set `MONITOR_CONFIG_FILE`, or put the JSON itself in `MONITOR_CONFIG` |
| `--state <file>` | Counts and times kept between runs, for dead-letter growth and last successful syncs across restarts. Or `MONITOR_STATE_FILE` |
| `--json` | Print the JSON result instead of the report |
| `--json-file <file>` | Also write the JSON result to a file |
| `--migrations <dir>` | Expect every `.sql` file there to be applied, such as `supabase/migrations`. Or `MONITOR_MIGRATIONS_DIR` |
| `--issues` | Keep the issues, as the workflow does. Or `MONITOR_ISSUES=true`. Needs `GITHUB_TOKEN` and `GITHUB_REPOSITORY` |

Keys come from the variable each instance's `supportKeyEnv` names, or from `MONITOR_SUPPORT_KEYS` as `NAME=key` lines. It exits 0 when every instance is healthy, 1 when something needs attention and 2 when the monitor couldn't run (a config it can't use, or GitHub turning down an issue update).

A report looks like this:

```
Instance monitor, 2026-11-22T12:00:00.000Z: 1 of 2 needs attention

ok    acme (https://acme-brain.example.test): v0.1.0, up 3d, 4 syncing, 0 dead letters, reasoning ok
FAIL  beta (https://beta-brain.example.test)
      - stripe: last sync failed 3h ago: vendor answered 500
      - 140 dead letters (limit 100); most from shopify 120, stripe 20
```

## What it keeps out of the output

- **Keys.** The config only names variables. The key is sent only to `/v1/support/status`, as a bearer token, never to `/healthz`, and never in a URL. Redirects aren't followed, so a key can't be carried to another host. Before anything is printed or written, every key the run used is replaced with `[redacted]`.
- **URLs.** The report shows each instance's scheme and host only. Config errors name the field, never its value.
- **Response bodies.** Only the fields the rules read are kept. An error answer's body is never read. Ids and source names that aren't plain lowercase ids show as `other`. A connector's last error, already scrubbed by the instance, is capped at 200 characters, with backticks and `@` taken out so it can't break an issue's formatting or mention anyone.
- **State.** The state file holds times and counts per instance and connector, nothing more.

## What each alert means and what to do

| Alert | Means | What to do |
| --- | --- | --- |
| `key_missing` | The variable named by `supportKeyEnv` isn't set | Add the secret, and its line in `SUPPORT_KEYS` |
| `unreachable` | No answer from `/healthz` or the status within the timeout, after one retry | Check the host: is the service running, and are its domain and certificate in order? |
| `healthz_status` | `/healthz` answered something other than 200, including a redirect | Check the host's logs and recent deploys. A redirect means `baseUrl` should be the final address |
| `status_http` | The status answered something other than 200: 401 when the support key doesn't match `SUPPORT_API_KEY`, 503 when support status isn't set up | Fix the key, or set up support status; otherwise check the host's logs |
| `status_unreadable` | The status isn't the shape this monitor reads | Run a monitor from the same release as the instance (`brain-ref`) |
| `connector_failed` | An enabled connector's last sync failed. Its scrubbed error is shown | Check the vendor credentials and the vendor's status page. The next run retries from its checkpoint |
| `connector_stale` | An enabled connector's last successful sync is older than `syncStaleHours` (default 24), or it hasn't succeeded since a start longer ago than that | Check that sync is running (`SYNC_INTERVAL_MINUTES`) and the vendor is answering |
| `connector_not_syncing` | A connector in `ENABLED_INTEGRATIONS` is missing settings, so it isn't syncing | Add the settings it names to the host's secret store, or take it out of `ENABLED_INTEGRATIONS` |
| `dead_letters_high` | More dead letters than `deadLetters` (default 100). The top sources are named | Look at dead letters by source and reason: a connector or webhook is sending input the instance can't take |
| `dead_letters_growing` | More dead letters than at the last check. Needs the state file; turn off with `deadLetterGrowth: false` | Check the sources named for a vendor change or a bad webhook |
| `migrations_none` | No migrations are applied | Run `npm run db:migrate` against the instance's database, or redeploy with `MIGRATE_ON_START=true` |
| `migrations_missing` | With expected migrations on, some aren't applied | The instance runs an older release than `brain-ref`; deploy the current image |
| `reasoning_failing` | Scheduled reasoning failed `reasoningFailures` runs in a row (default 3). The error's class name is shown | Check the host's logs for that error; reasoning retries at the next trigger |
| `reasoning_stale` | Scheduled reasoning hasn't succeeded for three intervals (at least an hour), or `reasoningStaleHours` when set, counting from the start when it hasn't succeeded yet | Check `REASON_SCHEDULE` and `REASON_INTERVAL_MINUTES`, and the host's logs for reasoning runs |

A connector with nothing to sync (webhook-only, or not built yet) isn't an alert, and neither is reasoning that is off or an instance from before scheduled reasoning. Each threshold can be set for every instance under `thresholds` at the top of the config, and overridden for one instance under its own `thresholds`.
