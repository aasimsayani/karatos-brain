### Asana

Reads Asana's REST API (`https://app.asana.com/api/1.0`) with an access token: the workspaces the token's user belongs to, each workspace's projects (archived ones too) with their sections, each project's tasks, and the comments on each task read.

| Setting | What it is |
| --- | --- |
| `ASANA_ACCESS_TOKEN` | A personal access token made by a user who sees only the projects to sync, or an OAuth app's token limited to read scopes |
| `ASANA_WORKSPACE_GID` | Optional. The one workspace to read; unset reads every workspace the user belongs to |

**Read-only.** The client sends only five GETs: `/users/me`, `/projects`, `/projects/{gid}/sections`, `/tasks` and `/tasks/{gid}/stories`, with parameters it builds itself. Ids and page offsets are checked before they go into a request, and the next page is asked for by its `offset`, never by following the `next_page` URI, so a reply can't send the token to another host. A personal access token can do anything its user can and can't be limited, so make it as a user added only to the projects to sync. Creating a task and commenting on one are declared behind the write gate, and the test shows each one is stopped.

**What it reads.** Every request names its fields with `opt_fields`, and none of them is a task's name or notes, a comment's text or a custom field's text. The first import reads tasks changed in the last five years, 100 a page. Each later sync asks only for tasks changed since the last pass started, less five minutes of overlap (`modified_since`). Each batch's checkpoint records the workspace, the project and the page offset it got to, so a resumed sync carries on. Asana's offsets expire; a resumed list whose offset Asana turns down is read again from its start, once, and what was already stored is a duplicate. A project deleted part way through a pass is skipped. A 429 is waited out for `Retry-After` seconds, up to a minute, three times, then left to `runSync`, which retries from the checkpoint. A 401 stops the sync saying the token was turned down; a 402 says the read needs a paid plan.

Asana doesn't count a new comment as a change to its task, so a comment on a task that otherwise didn't change is read with the task's next change. Subtasks aren't listed in a project unless they were added to it, so they aren't read.

**Events.** The same vendor-neutral work-tracking events monday.com sends, so a department reads both the same way.

| Event | From | Key |
| --- | --- | --- |
| `work.board_updated` | A project: its name, whether it's archived, start and due days, owner and team as `asana:user:<gid>` and `asana:team:<gid>`, its custom fields as columns and its sections as groups | project and `modified_at` |
| `work.item_updated` | A task: its project and section, kind (task, milestone or approval), whether it's done and when, created and modified times, start and due days and due time, assignee, parent task, and its custom field values | task and `modified_at` |
| `work.comment_updated` | A comment on a task: who wrote it and when | story and `created_at` |

Custom fields are kept only for types that hold no free text: number, single select and multi select (their option labels), date and people (as user ids). Text fields aren't asked for. Stories that aren't comments, such as a task being moved, are dropped. A record whose time doesn't read is dead-lettered.

**Webhooks.** None yet. The scheduled sync polls.

**Testing.** The tests run against a mock built from Asana's API reference (`packages/testkit/src/mocks/asana.ts`). Like Asana, it returns only the fields `opt_fields` names, so the tests show a task's name and notes never come back. It answers 401 for the wrong token, filters tasks by project and `modified_since`, pages with `offset`, and can answer 429 with `Retry-After` and 400 for an expired offset. Its assumptions are listed in the mock and checked on the first sandbox run. For the nightly run, make a free Asana workspace for testing only, add a project or two of synthetic tasks, make a personal access token as a user who belongs only to that workspace, and add it as the `SANDBOX_ASANA_ACCESS_TOKEN` GitHub Actions secret.
