### Airtable

Reads Airtable's Web API (`https://api.airtable.com/v0`) with a personal access token: the bases the token can see (or the ones `AIRTABLE_BASE_IDS` names), each base's tables with their fields, and each table's records.

| Setting | What it is |
| --- | --- |
| `AIRTABLE_ACCESS_TOKEN` | A personal access token with only the `data.records:read` and `schema.bases:read` scopes, and access to only the bases to sync |
| `AIRTABLE_BASE_IDS` | Optional. The bases to read, by id, separated by commas; unset reads every base the token can see |

**Read-only.** The client sends only four GETs: `/meta/whoami`, `/meta/bases`, `/meta/bases/{baseId}/tables` and `/{baseId}/{tableId}`, with parameters it builds itself. Ids, page offsets and the filter's time are checked before they go into a request. Before reading, the connector asks `/meta/whoami` for the token's scopes, and an OAuth token with any write or manage scope stops the sync. Airtable doesn't report a personal access token's scopes, so the connector can't check one; make it with the two read scopes only. Creating and changing a record are declared behind the write gate, and the test shows each one is stopped.

**What it reads.** Airtable returns every field of a record when a request names none, so every records request names its fields by id, and a table with no field the connector reads is kept for its structure only. Any field that comes back without being asked for is dropped. The fields read are those whose values hold no free text: number, currency, percent, rating, duration, auto number, count, checkbox, date, date and time, created and last modified time, single and multiple select (their option labels) and links to other records (as record ids). Text, long text, rich text, email, phone, URL, attachment, collaborator, created and modified by, barcode, button, formula, rollup, lookup and AI text fields are never asked for. A table that names more than 200 readable fields has its first 200 read.

The first import reads records made or changed in the last five years, 100 a page. Each later sync asks only for records made or changed since the last pass started, less five minutes of overlap, with `filterByFormula` on `LAST_MODIFIED_TIME()` and `CREATED_TIME()`. Each batch's checkpoint records the base, the table and the page offset it got to, so a resumed sync carries on. Airtable's offsets expire; a table whose saved offset Airtable turns down (422 `LIST_RECORDS_ITERATOR_NOT_AVAILABLE`) is read again from its start, once, and what was already stored is a duplicate. A base or table deleted part way through a pass is skipped. A 429 is waited out for 30 seconds, as Airtable asks, three times, then left to `runSync`, which retries from the checkpoint. A 401 stops the sync saying the token was turned down; a 403 names the scopes it needs. Airtable doesn't report deleted records to a reader, so a deleted record is simply no longer read.

**Events.** The same vendor-neutral work-tracking events monday.com, Asana and Trello send, so a department reads them all the same way.

| Event | From | Key |
| --- | --- | --- |
| `work.board_updated` | A table: its name, its base as `airtable:base:<id>` and the base's name, and every field's id, type and name as columns, each marked with whether it is read | table and a hash of what was read |
| `work.item_updated` | A record: its table and base, when it was made, when it last changed (from a last modified time field, when the table has one), and its read field values | record and a hash of what was read |

Airtable gives a table no modified time and a record none unless the table has a last modified time field, so each version is keyed by a hash of what was read: a change is stored once and a replay is a duplicate. A table's event is timed when it was seen. A record whose created time doesn't read is dead-lettered.

**Webhooks.** None yet. The scheduled sync polls.

**Testing.** The tests run against a mock built from Airtable's API reference (`packages/testkit/src/mocks/airtable.ts`). Like Airtable, it returns every field when none are named and only the named ones otherwise, and leaves empty fields out, so the tests show a text field's value never comes back. It answers 401 for the wrong token, 403 for a base the token can't see, reports scopes as it does for an OAuth token, applies the changed-after filter, pages with `offset`, and can answer 429 and 422 for an expired offset. Its assumptions are listed in the mock and checked on the first sandbox run. For the nightly run, make a free Airtable workspace for testing only, add a base or two of synthetic records, make a personal access token with only the two read scopes and access to that workspace's bases, and add it as the `SANDBOX_AIRTABLE_ACCESS_TOKEN` GitHub Actions secret.
