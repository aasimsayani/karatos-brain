### Supplier invoices and memos

Reads the invoices and memos a store or workshop gets from its suppliers, as CSV exports, one folder per supplier. Each line becomes the document, the item, its quantity and cost, and whether it is a natural or lab-grown diamond, with what the document says about where its diamonds came from. Memo lines also go to the memo reminder, so goods on memo are paid for or sent back on time.

| Setting | What it is |
| --- | --- |
| `SUPPLIER_INVOICES_IMPORT_DIR` | The folder of exports, outside any git repo. Inside it, one subfolder per supplier, named in lowercase letters, digits and underscores, such as `test_supplier`. Other folders are skipped |
| `SUPPLIER_INVOICES_PROFILES` | Optional. `generic`, or the path to a JSON file in the client's private instance repo mapping supplier folders to parsing profiles or `"generic"`, with `"*"` for the rest |

**Parsing profiles.** A profile names the document number and date columns, and a line amount or unit cost column. It can also name the document type, item (`sku`), description, stone, quantity, due date, terms and statement columns, the delimiter and the date order.

The generic profile reads:

- Invoice (or Invoice Number, Invoice No, Invoice #, Memo, Memo Number, Memo No, Memo #, Document, Document Number, Doc #)
- Date (or Invoice Date, Memo Date, Document Date)
- Type (or Document Type, Doc Type, Transaction Type)
- SKU (or Style, Style #, Style Number, Item #, Item Number, Stock #, Stock Number), Description (or Item Description, Details) and Stone (or Stone Type, Center Stone, Gem)
- Qty (or Quantity, Pcs, Pieces, Units)
- Unit Price (or Unit Cost, Price, Cost, Price Each) and Amount (or Extended, Ext Price, Extended Price, Line Total, Total)
- Due Back (or Return By, Memo Due, Memo Due Date, Due Date) and Terms (or Memo Terms, Payment Terms)
- Statement (or Warranty, Warranty Statement, Notes, Remarks, Comments)

**Values.**

- **Type** reads Memo, Memorandum, Consignment, Consigned or On Memo as a memo, and Invoice, Inv, Sale, Sales Invoice, Bill or Purchase as an invoice. Anything else, such as a credit note, is dead-lettered. Without a type column, a file whose name says memo or consignment holds memos, and any other holds invoices.
- **Money** is in cents. A line without an amount is its quantity (1 when there is no quantity column) times its unit cost.
- **Due dates** come from the due column. Without one, terms such as "Net 30", "30 days" or "30 day memo" count that many days from the document's date. For a memo it is the date the goods go back by; for an invoice, the date it is due.
- **Diamonds.** A line whose stone or description says diamond is a natural diamond, unless it also says lab-grown, lab-created, laboratory-grown, LGD, synthetic, man-made, CVD, HPHT or cultured. "Diamond-cut", "diamond-shaped" and similar metal finishes, and simulated or imitation diamonds, are not diamonds.

**Statements.** Each document's text is searched for the World Diamond Council's System of Warranties statement. The current wording reads: "The diamonds herein invoiced have been purchased from legitimate sources not involved in funding conflict, in compliance with United Nations Resolutions and corresponding national laws. The seller hereby guarantees that these diamonds are conflict free and confirms adherence to the WDC SoW Guidelines." A document carries it when its text has "not involved in funding conflict", "guarantees that these diamonds are conflict free", "System of Warranties" or "WDC SoW". It is `current` when it names the WDC SoW Guidelines, and `earlier` otherwise. The text is every cell of the document's rows. When a file holds one document, it also includes the lines above the header and rows without a document number, where a printed statement usually sits. `kimberleyProcess` says whether the text names the Kimberley Process.

**What it reads.** Each CSV in a supplier's folder, in name order, suppliers in name order. Title lines above the header are skipped: the header is the first line with the document number, the date and a money column. A row with a document number and an item, unit cost or amount is a line. A row with only words, such as a statement printed under the lines, counts toward its document's text. Documents older than six years are skipped. The checkpoint and resume work as for bank statements: a file is read again only when its content changes.

**Events.** Each line becomes `supplier_invoice.line_imported`. The payload has:

- `lineId`, which is `supplier:<supplier>:<type>:<number>:<n>`, where `n` counts the document's earlier lines in the same file
- `supplier`, `documentType`, `documentNumber` and `documentDate`
- `sku`, `description`, `stone`, `quantity`, `unitCostCents`, `amountCents`, `due` and `terms`, when the line has them
- `diamond` (`natural`, `lab_grown` or `none`), `warrantyStatement` (`current`, `earlier` or `none`) and `kimberleyProcess`
- `currency` and `sourceRow`

A memo line with an item, an amount above zero and a due date also becomes `memo.received`, with the memo id `<supplier>/<number>/<n + 1>`, since memo numbers repeat between suppliers.

The key adds a hash of what the line says, so the same line in two exports is stored once, and a corrected document is stored as its newer version. A line whose date, type or amount can't be read is keyed by where it is and dead-lettered with it kept.

**Checks.**

- The buying department's memo reminder follows each memo line from 14 days before it is due back. It says whether the item has sold, so the memo is paid for or the goods go back.
- The compliance department checks each invoice and memo from the last 90 days that lists a natural diamond. When no System of Warranties statement was found anywhere on the document, it suggests asking the supplier for a copy that carries it. It is a reminder, not legal advice. A statement printed only on a paper or PDF copy isn't in the CSV, so the reminder says no statement was found, not that none exists.

**Not yet read.** PDF invoices and memos, and memo returns and purchases (`memo.settled`), are a follow-up.

**Testing.** Synthetic exports only:

- an invoice export with a title block, a statement printed under the lines, natural, lab-grown and diamond-cut lines, and unreadable rows
- a memo export with terms instead of due dates and two documents in one file
- an overlapping corrected export

Invoices and memos are the client's business records and never go in a repo.
