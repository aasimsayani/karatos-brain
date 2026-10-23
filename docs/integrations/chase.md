### Chase

Chase business checking, savings and credit cards, from the CSV activity downloads in Chase's online banking, the monthly PDF statements, or both. It is the bank and credit card statements connector with Chase's own profiles built in, synced under its own source, `chase`, so no profile file is needed.

| Setting | What it is |
| --- | --- |
| `CHASE_IMPORT_MODE` | `manual_csv`, `manual_pdf` or `manual_csv_and_pdf`: which files in the folders to read. Anything else stops the sync with an error naming the three choices |
| `CHASE_MANUAL_IMPORT_DIR` | The folder of downloads, outside any git repo, with one subfolder per account like `checking-1234`, `savings-2345` or `card-5678`. Card and credit folders are read with the card profile, and the rest with the checking profile |

**What the profiles know.** For checking and savings, the CSV columns are Details, Posting Date, Description, Amount, Type, Balance and Check or Slip #, and the trailing comma Chase puts on every row is ignored. The PDF period line reads "December 16, 2025 through January 15, 2026", and lines under CHECKS PAID start with the check number, sometimes with a `^` or `*` mark, then the date paid. Those become `CHECK 1001` with the check number kept. For cards, the CSV columns are Transaction Date, Description and Amount, where purchases are negative and payments positive. The PDF closing date comes from "Opening/Closing Date 12/16/25 - 01/15/26", and charges sit under PURCHASE. Both profiles are also available to the generic connector by name in `BANK_STATEMENTS_PROFILES`.

The profiles were written from Chase's published download format and statement layout. Before sign-off, check them against one of the client's own statements and confirm the event count matches the statement's transaction count.

**Testing.** `packages/connectors/test/chase.test.ts` writes a synthetic two-page checking statement, a card statement and matching CSV downloads. It checks that each format reads the same transactions with the same keys, that each import mode reads only its own files, and that account folders get the right profile. No real statement goes in a repo.
