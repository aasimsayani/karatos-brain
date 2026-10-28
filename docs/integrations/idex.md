### IDEX Online

Reads the business's IDEX Onsite feed: the diamonds it offers from the IDEX trading network on its own website, with the filters and markups it set on IDEX. Buying and sales see what can be offered and at what price, and which stones were repriced or sold. It needs an IDEX trading subscription with the Onsite add-on.

| Setting | What it is |
| --- | --- |
| `IDEX_API_KEY` | The API key IDEX issues for the Onsite feed |
| `IDEX_API_SECRET` | The secret that comes with it. It is sent only to IDEX's two Onsite feed addresses, which are fixed in the client |
| `IDEX_FEEDS` | Optional. `natural`, `lab_grown` or both, comma-separated; `natural` when unset. The lab-grown feed is a separate IDEX add-on |
| `IDEX_MAX_STONES` | Optional. The most stones one feed may hold before the sync stops and asks for narrower filters, 50,000 when unset |

**What it reads.** Each sync asks IDEX for the whole feed as an unzipped CSV file (`format_20230628_extended` for natural stones, `format_lg_20221130` for lab-grown ones) and compares it with the last one read. IDEX makes a new file every hour or two and answers the previous one until then. A stone that is new, or whose grades or price changed, is recorded; one that left the feed is recorded as delisted, and one that comes back is recorded again. An empty file never delists the feed: the sync stops instead, since an empty file is far more likely a filter mistake than every stone selling at once. Files over 200 MB are not read.

IDEX's errors (HTTP 500 with a `result_info` code) stop the sync with the code and IDEX's description, with the key and secret taken out. A 429 waits as Retry-After says, up to a minute, three times.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `diamond_listing.listed` | A stone new to the feed or changed: IDEX item number, supplier stock number, shape, carat weight, color or fancy color, clarity, cut grade, polish, symmetry, lab and certificate number, price per carat and total price in cents after the business's markup, % off the IDEX list, measurements, proportions, fluorescence, shade, milkiness, eye-clean, brand, provenance, availability, location, and whether a certificate file, image, video or 3D view exists | feed, item number and a hash of what was read, plus how often the stone left the feed before |
| `diamond_listing.delisted` | A stone that left the feed | feed, item number and which departure this is |

A listing's time is when KaratOS saw it, since the feed doesn't say when a stone was listed. Media links aren't stored: they point at supplier hosting. A row without a readable item number, shape, carat weight or price, or one that repeats an item number, is dead-lettered with its line number and what was wrong; the rest of the feed is still read. A file missing a required column stops the sync, naming the columns. No department reasons over these events yet.

**Writes.** Declared and turned off: uploading the business's listings to IDEX, and asking a supplier to hold or send a stone.

**Testing.** The tests run against a mock built from IDEX's API pages (`packages/testkit/src/mocks/idex.ts`), which answers both feeds with synthetic stones under IDEX's documented header rows. It is checked live once a subscriber's key is connected.
