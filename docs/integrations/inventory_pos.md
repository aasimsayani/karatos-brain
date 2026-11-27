### Inventory and POS systems

Reads CSV exports from any point-of-sale system out of a folder: item lists, stock counts, customer lists, sales lines, repair tickets and bench job stages. Nothing is sent to or read from the POS itself, so there is nothing to write back and no webhooks.

| Setting | What it is |
| --- | --- |
| `POS_IMPORT_DIR` | The folder the exports are dropped into, outside any git repo |
| `POS_MAPPING_PROFILE` | Optional. `generic`, or the path to a mapping profile JSON in the client's private instance repo |

**Mapping profiles.** A profile names the file patterns for each kind of export, the column for each value, the delimiter, the date order (`mdy`, `dmy` or `ymd`), the store's UTC offset for times written without one, and the system's own payment and category labels. `parsePosProfile` validates one and says which field is wrong. Each column can list several header names; headers match without regard to case or spacing. A profile's `id` is part of every idempotency key, so it must not change once data is imported. Profiles for one client's system belong in that client's instance repo, never here.

The generic profile reads these files and columns. Columns marked * are required; a file missing one stops the sync with the file and the columns named.

| File name contains | Columns |
| --- | --- |
| `item` or `inventory` | SKU*, Title*, Cost*, Retail Price*, Category, Metal, Karat, Weight (g), Quantity, Vendor, On Memo, Received |
| `stock` or `on hand` | SKU*, On Hand*, Date |
| `customer` or `client` | Customer ID*, Name*, Marketing Opt In, Updated |
| `sale`, `transaction` or `receipt` | Sale ID*, Date*, SKU*, Quantity*, Unit Price*, Discount, Sale Total, Payment Method, Customer ID, Salesperson, Channel, Original Sale ID, Return ID |
| `repair`, `service ticket` or `job envelope` | Ticket*, Customer ID*, Item*, Work*, Promised*, Estimate*, Declared Value, Received, Status, Status Date |
| `bench`, `job bag`, `work order` or `production` | Job*, Stage*, Date*, Jeweler, Metal In (g), Metal Out (g), Labor Minutes, Labor Hours, QC Result, Sent Back To, Description, Promised, Repair Ticket, Custom Order, Metal. One row per stage a job enters; see [bench jobs](../departments/bench.md#bench-jobs-from-a-csv-export) |

Only `.csv` and `.txt` files are read. Items are read first, then stock, customers, sales, repairs and bench jobs, each in name order. A file name is matched against the kinds in that order, so a repairs export must not also contain `item` or `inventory`, and a bench export must not contain any earlier kind's words (`bench-repairs.csv` is read as repairs).

**What it reads.** Each sync reads the files that are new or changed since the last one. The checkpoint holds each finished file's SHA-256 and, for a file in progress, how many of its events are stored, so a crash resumes mid-file. A changed file is read again from the top, and its unchanged rows come back as duplicates. Files that leave the folder are dropped from the checkpoint. The historical import and incremental syncs work the same way. Rows dated more than five years back are skipped.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `inventory.received` | Each item row with stock. A row with quantity 0 (a piece already sold) is skipped | profile and SKU, so each piece is received once |
| `inventory.counted` | Each stock row: what was on hand on that date | profile, SKU and date |
| `customer.profile_updated` | Name and marketing consent. Consent is never assumed: an empty column is no | profile, customer and a hash of name and consent, so only a real change is a new event |
| `sale.completed` | Sale lines grouped by Sale ID. The export's Sale Total wins over the lines' sum, since it can include tax | profile and sale |
| `sale.returned` | Lines with a negative quantity, grouped by Return ID, or by Sale ID when there is none. A receipt with both (an exchange) gives a sale and a return | profile and return |
| `repair.received` | Each repair ticket: the item, the work, the promised day (read as the store's own calendar day) and the estimate | profile and ticket, so each ticket is taken in once |
| `repair.status_changed` | A ticket's status when it is past intake. Status words map by keyword: at bench or in progress, sent out or trade shop, ready or awaiting pickup, picked up or delivered, cancelled. A word that matches none is dead-lettered | profile, ticket and status, so a nightly export of open tickets stores each step once |
| `bench_job.stage_recorded` | Each bench row: the stage by keyword, its time, the jeweler, grams in and out, bench minutes (hours times 60 from an hours column), and a QC result and the stage it sends work back to. A stage or result word that matches none is dead-lettered | profile, job, stage and time |
| `bench_job.opened` | Each job in a bench file, with the last filled description, promised day, repair ticket, custom order and metal of its rows | profile, job and a hash of those, so only a real change is a new event |

Money reads `$1,250.00`, `1250.5` and `(25.00)` without floating point. Metal and karat come from the Metal column (`14K Yellow Gold` is gold, 14k); an unknown metal is kept as `posMetal`. Categories and payment labels map to the departments' values by keyword, after the profile's own labels. Exports list a tender per line, so a sale whose lines name different tenders gets one `other` payment. Rows without a date use the file's modified time, except sales, which need one.

A value that can't be read is left null, so the department schema dead-letters the row with the raw event kept, and every event carries `sourceRow` (`file.csv:12`) to find it. Only mapped columns are read: email addresses, phone numbers and street addresses in an export are never stored.

**Testing.** The tests use synthetic exports only. The CSV reader in `packages/connectors/src/files` (RFC 4180 quoting, CRLF, byte-order marks) and its money, date and flag parsers are shared with the bank statement connector.
