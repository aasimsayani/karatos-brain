### RFID and barcode tray counts

Reads the counts an RFID reader or barcode scanner takes of each tray and case, exported as CSV into a folder, so the inventory department can check each night's count against what should be there.

| Setting | What it is |
| --- | --- |
| `RFID_COUNTS_IMPORT_DIR` | The folder the reader software saves its count exports into, outside any git repo |
| `RFID_COUNTS_DATE_ORDER` | Optional. `mdy` (the default), `dmy` or `ymd` |
| `RFID_COUNTS_UTC_OFFSET` | Optional. The store's offset from UTC, such as `-05:00`, for scan times written without one. UTC when unset |

**The export.** One row per tag read, saved as CSV (or a `.txt` file in CSV form). Every such file in the folder is read. The columns it reads:

```text
Session ID,Tray,Tag,SKU,Scanned At,Staff,Status
```

- **Required:** Tray (or Case, Showcase, Location, Zone), Tag (the EPC, or the barcode on a barcode count; also Tag ID, EPC, RFID, Barcode), and Scanned At (also Scan Time, Read Time, Timestamp, Date).
- **Optional:**
  - Session ID, when the software numbers its counts. Without it, all of a tray's rows in one file are one count, so export one file per count or per night.
  - SKU, the stock number the tag is attached to, so a missing piece can be named and valued
  - Staff, the person who did the count, as a name or employee number
  - Status, when the software knows what belongs in the tray: Found (or OK, Scanned, Matched), Missing (or Not Found, Absent) and Unexpected (or Extra, Wrong Tray, Misplaced). Blank is found, so a plain read export works too. A missing row may leave the scan time blank, since the tag was never read.

**Events.** Each count becomes `inventory.tray_counted` with the tray, the session id when there is one, when the count started and ended, who did it, and the tags found, missing and in the wrong tray, each with its SKU when the export has one. A reader picks up a tag many times; it counts once, as unexpected if any read says so, else found if it was read at all. Its time is the last scan of the count, or the file's own time when nothing was read. The key is `rfid_counts:count:<tray>:<time>:<hash of what the count found>`, so the same export read again, or saved under another name, stores nothing new. A count split across two files reads as two counts.

A count with a row that can't be read (no tag, a tag that isn't an EPC or barcode, a status the connector doesn't know, a scan time that isn't a date or is blank on a piece that was read, a staff column with control characters) becomes an event with no time and the problems, line by line, so the pipeline dead-letters it with the rows kept: a count with a bad row would say the wrong thing. So does a count of more than 5,000 tags, and a row with no tray. Counts older than two years are skipped. The checkpoint and resume work as for the POS connector: a file is read again only when its content changes.

**What the inventory department does with it.** It looks at each tray's latest count. When pieces are missing it names up to five tags (with their SKUs) and says how many more, adds up what the store paid for those whose SKU it has seen received, and asks the store to check the safe, repair envelopes and pieces out on memo or approval before calling it a loss. Pieces read in the wrong tray are pointed out too. A piece missing one night and found the next drops off, because only the latest count of a tray counts.

**Testing.** Synthetic exports only: a count with found, missing and wrong-tray pieces, repeated reads, counts with and without session ids, a count where nothing was read, day-first dates and a store offset, unreadable rows, a blank line, an export saved again under another name, and resuming after a crash. The department tests cover a short count valued from receipts, a wrong-tray piece, and a later clean count clearing the reminder.
