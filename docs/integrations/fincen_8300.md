### FinCEN Form 8300 cash reporting

Reads the store's own Form 8300 filings log, kept as CSV in a folder, so the brain knows which cash sales are already reported, which filings FinCEN rejected, and which customers still need their written statement.

**Why a log.** A business that receives more than $10,000 in cash in one transaction, or in related transactions, files Form 8300 within 15 days through FinCEN's BSA E-Filing System. BSA E-Filing has no API, so filing stays with a person. The compliance department finds the cash sales that need a filing from the POS and bank data; the log tells it what has been filed since.

| Setting | What it is |
| --- | --- |
| `FINCEN_8300_IMPORT_DIR` | The folder holding the filings log, outside any git repo |
| `FINCEN_8300_DATE_ORDER` | Optional. `mdy` (the default), `dmy` or `ymd` |

**The log.** One row per filing, saved as CSV. Every CSV in the folder is read, so a store can keep one log or one per year. Start from this header row:

```text
Filed On,Cash Received On,Sale IDs,Customer ID,Cash Amount,BSA Tracking ID,BSA ID,Status,Statement Sent On,Suspicious
```

- **Required:** Filed On, Cash Received On (the date of the payment that took the total over $10,000), Sale IDs (the receipt numbers staff see, separated by commas, semicolons or spaces), and Cash Amount.
- **Optional:**
  - BSA Tracking ID, which BSA E-Filing shows on submission, and BSA ID, the 14-digit number it gives once the filing is accepted
  - Status: Submitted, Accepted, Accepted with Warnings or Rejected (blank is submitted)
  - Customer ID, the POS customer number
  - Statement Sent On, the day the customer was given their written statement
  - Suspicious: Yes for a filing made voluntarily for a suspicious transaction (box 1b)

Other names are read too, such as Date Filed, Transaction Date, Sale ID, Total Cash and Filing Status. **Never put names, addresses or taxpayer numbers in the log.** The connector reads only the columns above, so those stay on the form itself.

**Events.** Each row becomes `compliance.form_8300_filing_recorded` with the filing date, the date the cash was received, the sales, the cash in cents, the status, the days it took to file, and any BSA numbers, customer number, statement date and suspicious flag. A filing is named by its BSA ID, else its BSA Tracking ID, else its sales and the cash date. The key is `fincen_8300:filing:<filing>:<hash of what the row says>`, so the same log saved again stores a filing again only when something about it changed, such as a status moving to accepted. Keep the tracking ID on the row after adding the BSA ID so both versions read as one filing. Its time is the filing date.

A row with a problem (a missing or impossible date, filed before the cash came in, sales that aren't receipt numbers, an amount that isn't money, an unknown status, a BSA ID that isn't 14 digits, a tracking ID that isn't 6 to 20 digits, a suspicious flag that isn't yes or no) becomes an event with no time and a list of its problems, so the pipeline dead-letters it with the row kept. Filings older than five years are skipped; the IRS asks for copies to be kept for five years from the filing date. The checkpoint and resume work as for the POS connector: a file is read again only when its content changes.

**What the compliance department does with it.**

- The Form 8300 reminder for a cash sale stops once a filing in the log covers the sale. A receipt number in the log ("S-4015") matches the POS connector's full sale id ("pos:generic:sale:S-4015").
- If FinCEN rejects the filing, the reminder comes back, saying so, until a new filing is accepted or submitted. A later row for the same filing that still says submitted doesn't undo the rejection.
- Each person named on a required filing must get a written statement by January 31 of the year after the cash came in, giving the business's contact name, phone number and address, the total cash reported, and that it was reported to the IRS. The reminder runs from December 1 of that year until the statement date is in the log, and to the end of the next year at most. It never runs for a filing marked suspicious or for $10,000 or less, since a customer must not be told about a voluntary filing.

These are reminders for the owner, not legal advice.

**Testing.** Synthetic logs only: every status, a filing named by its BSA ID, its tracking ID and neither, a voluntary filing, unreadable rows, a blank line, day-first dates, and the same log saved again after FinCEN accepts a filing. The department tests cover a covered sale, a receipt number matched to the POS id, a rejection and the new filing after it, and the statement reminder across the year.

Rules come from the IRS [Instructions for Form 8300](https://www.irs.gov/instructions/i8300), which the docs watch follows.
