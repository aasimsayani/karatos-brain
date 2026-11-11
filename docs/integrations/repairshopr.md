### RepairShopr

Reads a repair shop's RepairShopr tickets, estimates and invoices, so each job can be followed from intake through its quote to the invoice and whether it was paid. Each arrives as a `repair.*` event.

| Setting | What it is |
| --- | --- |
| `REPAIRSHOPR_API_TOKEN` | A RepairShopr API token with only the Tickets, Estimates and Invoices List/Search permissions |
| `REPAIRSHOPR_SUBDOMAIN` | The account's subdomain, like `example` in `example.repairshopr.com` |

**Read-only by design.** A RepairShopr API token can be given custom permissions. Make one for KaratOS with only Tickets - List/Search, Estimates - List/Search and Invoices - List/Search, and no create, edit or delete permission. The client keeps to the reads as well: it sends only GET requests to those three lists, to the one account the settings name. Nothing is written back, so no write is declared. RepairShopr's own error text is never repeated in an error, only the HTTP status.

**What it reads.** A pass reads tickets, estimates and invoices, one list after another, a page at a time. The first import reads five years of tickets and invoices by when they last changed (`since_updated_at`), and the estimates made in that time (`created_after`). Each later sync reads the tickets and invoices changed since an hour before the last pass started. RepairShopr can't list estimates by when they changed, so each later sync reads again the estimates made in the 60 days before that, which catches a quote approved or declined in that time. Each page is one batch and one checkpoint, which keeps the list and the next page. A page count in the answer (`meta.total_pages`) says when a list ends; without one, an empty page does.

**Events.** A ticket has its number, status, customer, when it was opened and its due date. An estimate has its number, status, customer, date, subtotal, tax and total. An invoice has its number, customer, ticket, location, date, due date, subtotal, tax and total, and whether it's paid, verified paid or marked paid by a tech. Each is keyed by a digest of what was kept, so an unchanged record is a duplicate and a new status or payment is a new event. One without an ID or a time that reads is dead-lettered.

**Privacy.** A customer is kept as their RepairShopr ID, never their name, business name, email, phone or address. A ticket's subject and comments, and an invoice's note, PO number and PDF link, are not kept.

**Rate limits.** RepairShopr allows 180 requests a minute. The client waits out a 429 for as long as `Retry-After` says, up to a minute, or a full minute without one, and a 500, 502, 503 or 504 a few seconds, three times, before the error goes to the sync runner, which resumes from its checkpoint next time.

**Testing.** The tests run against a mock built from RepairShopr's docs (`packages/testkit/src/mocks/repairshopr.ts`). It checks the token, the time each list is read from and the paging, and lists what the first trial run must confirm: that the lists answer under their names with a page count, how the time parameters compare, and that pages keep a stable order.
