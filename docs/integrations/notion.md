### Notion

Reads Notion's API (`https://api.notion.com/v1`, version `2026-03-11`) with an internal connection's secret: the data sources (database tables) shared with the connection, or the ones `NOTION_DATA_SOURCE_IDS` names, each one's properties, and its pages.

| Setting | What it is |
| --- | --- |
| `NOTION_ACCESS_TOKEN` | The secret of an internal connection with only the Read content capability and no user information, shared with only the databases to sync |
| `NOTION_DATA_SOURCE_IDS` | Optional. The data sources to read, by id, separated by commas; unset reads every data source shared with the connection |

**Read-only.** The client sends only three requests: `POST /search` for data sources, `GET /data_sources/{id}` and `POST /data_sources/{id}/query`. Search and query are POSTs in Notion's API, but both only read. Ids, page cursors and the edited-since time are checked before they go into a request, and the request bodies are built by the client. Notion's API can't report what a connection may do, so make it with the Read content capability only. Creating and changing a page are declared behind the write gate, and the test shows each one is stopped.

**What it reads.** Notion returns every property of a page when a query names none, so every query names its properties by id with `filter_properties`, and a data source with no readable property is kept for its structure only. Any property that comes back unasked is dropped. The properties read are those whose values hold no free text: number, checkbox, date, select, multi-select and status (their option labels), created and last edited time, relation (as page ids), people (as user ids) and unique id. Title, text, email, phone, URL, files, formula, rollup, created and edited by, verification, button and place properties are never asked for, and a page's own address, which holds its title, isn't kept. A data source with more than 100 readable properties has its first 100 read.

The first import reads pages edited in the last five years, 100 a page, oldest edit first. Each later sync asks only for pages edited since the last pass started, less five minutes of overlap. Each batch's checkpoint records the data source and the latest edit time read, so a resumed sync asks again from there, and pages already stored are duplicates; Notion's page cursors aren't kept. Notion stops one query at 10,000 pages, so the connector then asks again from the latest edit time read. A data source deleted or unshared part way through a pass is skipped, but one named in `NOTION_DATA_SOURCE_IDS` that isn't shared stops the sync saying so. A 429 is waited out for `Retry-After` seconds, up to a minute, three times, then left to `runSync`, which retries from the checkpoint. A 401 stops the sync saying the token was turned down; a 403 names the capability it needs. Notion doesn't report deleted pages to a query, so a deleted page is simply no longer read.

**Events.** The same vendor-neutral work-tracking events monday.com, Asana, Trello and Airtable send, so a department reads them all the same way.

| Event | From | Key |
| --- | --- | --- |
| `work.board_updated` | A data source: its name, its database as `notion:database:<id>`, whether it is in the trash, when it was made, and every property's id, type and name as columns, each marked with whether it is read | data source and a hash of what was read |
| `work.item_updated` | A page: its data source, when it was made and last edited, and its read property values | page and a hash of what was read |

Notion keeps edit times to the minute, so each version is keyed by a hash of what was read: a change is stored once and a replay is a duplicate. A record whose edit time doesn't read is dead-lettered.

**Webhooks.** None yet. The scheduled sync polls.

**Testing.** The tests run against a mock built from Notion's API reference (`packages/testkit/src/mocks/notion.ts`). Like Notion, it returns every property when none are named and only the named ones otherwise, so the tests show a title or text property never comes back. It answers 401 for the wrong token, 400 without the API version, 404 for a data source that isn't shared, applies the edited-since filter and sort, pages with `start_cursor`, stops a query at its result limit, and can answer 429. Its assumptions are listed in the mock and checked on the first sandbox run. For the nightly run, make a free Notion workspace for testing only, add a database or two of synthetic pages, make an internal connection with only Read content, share the databases with it, and add its secret as the `SANDBOX_NOTION_ACCESS_TOKEN` GitHub Actions secret.
