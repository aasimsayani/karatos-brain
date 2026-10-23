### Bank and credit card statements

Reads bank and credit card activity exported as CSV, and PDF statements, one folder per account. Both go through the same keys, so a transaction in both formats is stored once.

| Setting | What it is |
| --- | --- |
| `BANK_STATEMENTS_IMPORT_DIR` | The folder of exports, outside any git repo. Inside it, one subfolder per account named for its type and last four digits: `checking-1234`, `savings-2345`, `card-5678`. A name containing `card` or `credit` is read as a credit card. Other folders are skipped |
| `BANK_STATEMENTS_PROFILES` | Optional. A built-in profile's name (`generic`, `chase_checking`, `chase_card`), or the path to a JSON file in the client's private instance repo mapping account folders to parsing profiles or built-in names, with `"*"` for the rest |

**Parsing profiles.** A profile names the date and description columns, either one signed amount column or separate debit and credit columns, and optionally balance and check number. It also gives the delimiter, the date order, the bank's UTC offset, how the amount column is signed (`money_in_positive`, or `money_out_positive` for card exports that show purchases as positive), and the client's own category rules: regular expressions tested against the description, in order. The generic profile reads Date (or Posting Date, Transaction Date, Posted Date), Description (or Memo, Details, Payee), Amount or Debit and Credit (or Withdrawals and Deposits), Balance and Check Number. Rules naming a client's payees belong in their instance repo.

**What it reads.** Each CSV in an account's folder, in name order, accounts in name order. Title lines above the header are skipped: the header is the first line with every required column. Rows with no date or no amount (opening balances, totals) are skipped, and rows older than six years too. The checkpoint and resume work as for the POS connector: a file is read again only when its content changes.

**PDF statements.** Each PDF in an account's folder is read as text, line by line, with table columns two or more spaces apart. A profile's `pdf` layout says how to read it; the generic layout reads the common one:

- **Transaction lines:** a date (`01/05`, or with the year), the description, then the amount, and sometimes a running balance.
- **Section headings** set how amounts below them are signed, since statements list deposits and withdrawals under their own headings without minus signs. Deposits, additions, credits, and payments and credits read as money in. Withdrawals, debits, checks, fees, purchases, cash advances and interest charged read as money out. Account summaries and daily balance tables are skipped. Outside those sections, an amount is read as written; `(25.00)`, `-25.00`, `25.00-` and `−25.00` are all money out.
- **Years:** a date without a year takes the year of the statement's closing date (found from "through 01/15/2026", "Closing Date 01/12/2026" and the like), or the year before when it falls after the closing day, so December lines on a January statement land in December.
- **Not transactions:** opening, closing, beginning, ending and new balance lines, and totals.

A dated line with money on it, under a transactions heading, that the layout can't read is dead-lettered with its page and line kept (`checking-1234/jan.pdf:p2:5`), never dropped. A PDF with no transactions and no headings the layout knows stops the sync with the file named, since it needs a profile. A client's own layout goes under `pdf` in their profile: `transaction`, a regular expression with named groups `date`, `description`, and `amount` (or `debit` and `credit`), optionally `balance`; `period`, with a group named `end`; `sections`, each a pattern and `money_in`, `money_out`, `signed` or `skip`; and `ignore` patterns.

PDFs come from outside, so the reader (pdf.js) renders no forms and loads no fonts, a file over 20 MB or 300 pages is rejected, a text line over 500 characters (longer than any statement prints) is never matched against the layout's patterns but dead-lettered if it starts with a date, and a password-protected statement stops with a message asking for one without a password. The instance image leaves out pdf.js's optional native canvas package, which only drawing needs.

**Events.** Each row becomes `bank.transaction_imported` in the finance department's shape, with money into the account positive. The key is `bank:<account>:<date>:<amount cents>:<n>`, where `n` counts identical transactions earlier that day in the same file, so two $20 payments on one day are both kept and an overlapping export stores neither twice. The payload adds `accountKind`, `balanceCents` and `checkNumber` when present, and `sourceRow` (`checking-1234/jan.csv:12`). A date or amount that can't be read is dead-lettered with the row kept.

**Categories.** After the profile's own rules:

| Category | Built-in rule |
| --- | --- |
| `card_settlement` | Money into a bank account from a processor: Stripe, Square, Shopify, PayPal, Clover, Heartland, Worldpay, Authorize.net, or "bankcard", "merchant" or "settlement" |
| `other` | Transfers between the business's own accounts and card payments, in either direction |
| `payroll` | Money out to Gusto, ADP, Paychex, Rippling, or described as payroll or wages |
| `fee` | Fees, service and maintenance charges, overdrafts, NSF, interest and finance charges |
| `other` | Mobile, remote and check deposits, ACH, wires, Zelle, refunds and interest paid in |
| `cash_deposit` | Other money into a bank account described as cash, a branch, teller, night or counter deposit, or starting "DEPOSIT". A client who deposits checks at the branch needs a profile rule |
| `vendor_payment` | Money out by check, ACH, wire, bill pay, Zelle, debit card or POS purchase, and every other charge on a credit card |

Anything else is `other`. The finance department compares `cash_deposit` transactions with cash sales.

**Testing.** Synthetic statements only: a title block above the header, debit and credit columns, opening balance and total rows, identical same-day payments, an overlapping export in another layout, and unreadable rows. PDF fixtures are written by the test itself with `syntheticPdf` from the connector test kit: a two-page checking statement spanning December and January, a card statement, a custom debit-and-credit layout, and a PDF that matches no layout. Statements are customer data and never go in a repo.
