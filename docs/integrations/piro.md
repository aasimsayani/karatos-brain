### PIRO

Reads PIRO's job and casting tree reports, exported as CSV into a folder, for jewelry manufacturers and wholesalers: where each job stands, and how much metal each casting tree took and gave back.

**How it reaches PIRO.** PIRO offers three routes:

- **Report exports.** Every account can export reports as CSV, by hand or as a scheduled data extract. This connector reads those.
- **EDI and XML** for exchanging documents with retail partners. PIRO's EDI documents (purchase orders, ship notices, invoices) are read by the [EDI X12](edi_x12.md) connector pointed at the folder PIRO writes them to, so they are not read twice.
- **A REST API** that PIRO offers for custom integrations it sets up. It is not public, so it would need PIRO's help and is not used yet.

| Setting | What it is |
| --- | --- |
| `PIRO_IMPORT_DIR` | The folder of report exports, outside any git repo |
| `PIRO_MAPPING_PROFILE` | Optional. `generic`, or the path to a profile JSON file in the client's private instance repo |

**Which files.** A profile's `files` patterns are tested against each CSV's name, casting first. The generic profile reads names with "cast" or "tree" as casting tree reports, and names with "job", "work order" or "manufactur" as job reports. Other files are skipped.

**Mapping profiles.** PIRO lets each account choose its report columns, so a profile names them. The generic profile reads the common names.

Job reports:

- **Required:** Job No (or Job Number, Job #, Job ID, Work Order) and Status.
- **Optional:**
  - Last Updated, Department (or Stage, Process), Style No, SKU and Order No
  - Metal, Karat and Qty
  - Start Date, Due Date and Completed Date
  - estimated and actual weights in grams or pennyweight, such as "Est Weight (g)" and "Actual Weight (dwt)"
  - Tree No

Casting tree reports:

- **Required:** Tree No, Cast Date, Metal, and the metal issued in grams or pennyweight, such as "Issued Weight (g)".
- **Optional:** Karat, Status, the weights returned, of the castings and of the scrap (button, sprues), and Jobs (separated by commas, semicolons or spaces).

Each weight unit has its own columns, so a weight is never read in a guessed unit. A value labeled with another unit ("12 g" in a pennyweight column) is a problem. A profile can also set the delimiter, the date order, the shop's UTC offset, and its own status labels.

**Statuses.** Each job's label is kept as `statusLabel` and mapped to a `status`. The profile's own labels are checked first, then the built-in words, top to bottom:

| Built-in words | Status |
| --- | --- |
| cancelled, canceled, void, scrapped | `cancelled` |
| on hold, hold, paused, waiting | `on_hold` |
| completed, finished, done, closed, shipped, delivered, invoiced | `completed` |
| not started | `open` |
| in progress, WIP, started, casting, setting, polishing, finishing, bench, filing, assembly, QC | `in_progress` |
| open, new, pending, issued, released | `open` |

Anything else is `other`.

**Events.**

- **`manufacturing.job_updated`.** A job, with its status, stage, style, SKU, order number, metal, karat, quantity, dates, estimated and actual weights in grams, the difference between them, and its tree. Customer names are never read; a job keeps only its order number. The key is `piro:job:<job number>:<hash of what the row says>`, so a report exported every day stores a job again only when something about it changed. Its time is the row's last update, then its completed or start date, then when the file was exported.
- **`manufacturing.casting_recorded`.** A casting tree, with the metal issued, castings, scrap and everything returned in grams (summed from castings and scrap when there's no total), `lossGrams` and `lossPercent`, and its jobs. It is keyed the same way, at its cast date.

A row with a problem (no job or tree number, a date or weight that can't be read, a metal that isn't exactly one metal, a karat outside 1 to 24) becomes an event with no time and a list of its problems, so the pipeline dead-letters it with the row kept. Rows older than five years are skipped. The checkpoint and resume work as for the POS connector: a file is read again only when its content changes.

**Testing.** Synthetic reports only:

- a job report with every status kind, rows with and without dates, unreadable rows, and a blank line
- a pennyweight casting report with and without a returned total, and trees with a weight in the wrong unit, an impossible date or an unknown metal
- a second day's export with one job changed
- a client profile with its own delimiter, date order, columns and status label

Column names are checked against a client's own export on the first account.
