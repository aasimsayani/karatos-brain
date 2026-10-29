### Refiner and scrap settlement statements

Reads the settlement statements a refiner sends after it melts and assays a lot of scrap, bench sweepings or old stock, as CSV exports or PDF statements, one folder per refiner. Each line becomes the lot, the metal, its weights in grams, the assay, the fine metal credited, and the money, for the metals department.

| Setting | What it is |
| --- | --- |
| `REFINER_STATEMENTS_IMPORT_DIR` | The folder of statements, outside any git repo. Inside it, one subfolder per refiner, named in lowercase letters, digits and underscores, such as `test_refinery`. Other folders are skipped |
| `REFINER_STATEMENTS_PROFILES` | Optional. `generic`, or the path to a JSON file in the client's private instance repo mapping refiner folders to parsing profiles or `"generic"`, with `"*"` for the rest |

**Parsing profiles.** A profile names the settlement date, lot and metal columns, and the weights: gross (as received), melt (after melting) and fine (pure metal credited), each in grams, pennyweight or troy ounces. Each unit has its own column (`fineGrams`, `fineDwt`, `fineOzt` and so on), so a weight is never read in a guessed unit, and a value labeled in another unit ("12.5 g" in a pennyweight column) is dead-lettered. It can also name the description, assay (`fineness`), price per ounce, credit, fee and net columns, the delimiter and the date order. A profile needs a fine weight column, or a weight and an assay to work it out from.

The generic profile reads:

- Settlement Date (or Date, Settled, Statement Date)
- Lot (or Lot Number, Lot #, Lot No, Reference, Ref)
- Metal (or Metal Type), and Description (or Material, Item)
- Gross, Melt and Fine weights as "Gross DWT", "Melt Grams", "Fine Oz", "Fine Weight (dwt)" and the like
- Assay (or Fineness, Purity, Assay %)
- Price (or Price per Oz, Metal Price, Spot)
- Credit (or Metal Value, Value, Gross Value, Amount)
- Fee (or Fees, Refining Fee, Charges, Treatment Charge)
- Net (or Net Amount, Net Value, Net Credit)

**Values.**

- **Weights** are stored in grams, to the milligram. A pennyweight is 1.55517384 g and a troy ounce 31.1034768 g.
- **Assay** reads as `58.5%`, `0.585`, `58.5`, `585` (parts per thousand) or `14K`. A bare 1 is pure.
- **Metal** reads from Gold, Silver, Platinum and Palladium, or Au, Ag, Pt and Pd. A line naming two metals is dead-lettered.
- **Money** is in cents. Fees are stored as money taken, however the statement signs them.

**What it reads.** Each CSV in a refiner's folder, in name order, refiners in name order. Title lines above the header are skipped: the header is the first line with the date, lot, metal and a weight. Rows with no date (subtotals, totals) are skipped, and lines older than five years too. The checkpoint and resume work as for bank statements: a file is read again only when its content changes.

**PDF statements.** Refiners lay out their PDFs too differently for one pattern to read them safely, so a PDF is read only for a refiner whose profile has a `pdf` layout. Without one, the sync stops with the file named and asks for a CSV export or a layout. A layout has:

- `line`: a regular expression, or a list tried in order, with named groups for the fields it shows (`date`, `lot`, `metal`, and weights such as `grossGrams`, `fineness` and `fineDwt`, then `credit` and so on).
- `ignore`: patterns for lines that aren't settlements, such as totals.

A PDF the layout matches nothing in stops the sync with the file named. PDFs are read with the same limits as bank statements: no forms, no fonts, and at most 20 MB and 300 pages.

**Events.** Each line becomes `refining.settlement_line_imported`. The payload has:

- `lineId`, which is `refiner:<refiner>:<lot>:<metal>:<n>`, where `n` counts that lot's earlier lines for the metal in the same file
- `refiner`, `lot`, `settledOn` and `metal`
- the weights in grams and the assay as a fraction (`fineness`)
- `fineGrams`, `fineTroyOunces`, and `fineFrom`, which is `statement`, or `assay` when it was worked out
- the price, credit, fee and net in cents, with `currency`
- `fineWeightCheck` and `expectedFineGrams`
- `sourceRow`

The key adds a hash of what the line says. So the same line in two exports, or in a CSV export and a PDF statement, is stored once, and a corrected statement for the lot is stored as its newer version. A line whose date, lot, metal or fine weight can't be read is keyed by where it is and dead-lettered with it kept.

**Checks.** `fineWeightCheck` is `matches` when the statement's fine weight is its melt weight (or gross weight, without a melt) times its assay, within half a percent or 10 milligrams. Otherwise it is `differs`. It is `not_checked` when the statement doesn't show both a weight and an assay, or when the fine weight was worked out from them.

The metals department raises two kinds of recommendation:

- When a lot is credited less fine metal than its assay says, it asks for a recheck.
- When a lot paid less than 90% of spot per fine ounce, against the spot price from the settlement day or the week before it, it suggests a second quote.

A later version of a lot replaces the earlier one in both checks.

**Testing.** Synthetic statements only:

- a pennyweight statement with a title block, a lot with gold and silver lines, a lot credited short, a fine weight worked out from the assay, and unreadable rows
- a grams statement with parts-per-thousand fineness
- an overlapping corrected export
- PDF statements written by the test with `syntheticPdf`: one read with a layout, one with no layout, and one the layout matches nothing in

Statements are the client's business records and never go in a repo.
