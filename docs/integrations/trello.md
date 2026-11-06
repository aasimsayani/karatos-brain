### Trello

Reads Trello's REST API (`https://api.trello.com/1`) with a Power-Up's API key and a member's token: the token's own permissions, the boards the member can see (closed ones too), and each board's lists, custom fields, cards and card actions.

| Setting | What it is |
| --- | --- |
| `TRELLO_API_KEY` | The API key of a Power-Up made for KaratOS in the client's workspace |
| `TRELLO_TOKEN` | A token authorized with `scope=read` only, by a member who sees only the boards to sync |

**Read-only.** Before every sync the connector asks Trello what the token may do (`GET /tokens/{token}?fields=permissions`) and stops if any permission can write, saying to authorize a new read-only token and revoke the old one. The client sends only six GETs: that one, `/members/me/boards`, and a board's `/lists`, `/customFields`, `/cards` and `/actions`, with parameters it builds itself. The key and token go in the `Authorization` header, not the URL, and every board, card and action id is checked before it goes into a request. Creating and moving a card are declared behind the write gate, and the test shows each one is stopped.

**What it reads.** Every request names its fields, and none of them is a card's name or description. Trello can't list cards by when they changed, so each pass reads every card on each board, 1,000 a page, paging back by the oldest card's id, and keeps those active since the pass's start; a card read again unchanged is a duplicate. Then it reads the board's card actions since that time, 1,000 a page, newest first: cards created, copied or moved onto the board, moved between lists, deleted, and commented on. The first import starts five years back. Each later sync starts where the last pass began, less five minutes. Each batch's checkpoint records the board and the page it got to, so a resumed sync carries on. A board deleted, or that the member lost access to, part way through a pass is skipped. A 429 waits for Trello's next 10-second window, three times, then is left to `runSync`, which retries from the checkpoint. A 401 stops the sync saying the key and token were turned down.

**Events.** The same vendor-neutral work-tracking events monday.com and Asana send, plus card moves.

| Event | From | Key |
| --- | --- | --- |
| `work.board_updated` | A board: its name, whether it's closed, when it was made, its workspace, its lists as groups (name, position, archived) and its custom fields as columns | board and last activity |
| `work.item_updated` | A card: its board and list, whether it's archived, whether its due date is marked done, when it was made and last active, start and due times, members as `trello:member:<id>`, label names, checklist items and how many are checked, how many comments, and its custom field values | card and last activity |
| `work.item_moved` | A card added to a list (created, copied or moved onto the board) or moved between lists: from and to which list, when, and by whom | action |
| `work.item_deleted` | A card deleted | action |
| `work.comment_updated` | A comment on a card: who wrote it and when | action |

Custom fields are kept only for types that hold no free text: number, date, checkbox and dropdown (its option label). Text fields are dropped. An action's data also carries the comment's text and the card's and list's names; only their ids are read. A card whose last activity doesn't read is dead-lettered.

**Webhooks.** None yet. The scheduled sync polls.

**Testing.** The tests run against a mock built from Trello's API reference (`packages/testkit/src/mocks/trello.ts`). Like Trello, it returns only the fields asked for, except an action's data, which it returns whole, so the tests show card names, descriptions and comment text never reach a stored event. It answers 401 for the wrong key or token, reports a write token's permissions, filters closed cards, pages cards and actions with `before`, and can answer 429. Its assumptions are listed in the mock and checked on the first sandbox run. For the nightly run, make a free Trello workspace for testing only with a board or two of synthetic cards, a Power-Up for its API key, and a read-only token for a member who belongs only to it, and add them as the `SANDBOX_TRELLO_API_KEY` and `SANDBOX_TRELLO_TOKEN` GitHub Actions secrets.
