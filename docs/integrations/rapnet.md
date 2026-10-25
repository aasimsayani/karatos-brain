### RapNet and the Rapaport Price List

Reads the weekly Rapaport Price List for round and pear diamonds through Rapaport's Price List API, so buying, appraisals and wholesale price a stone against the same list. It needs a Rapaport subscription that includes the price list.

| Setting | What it is |
| --- | --- |
| `RAPNET_CLIENT_ID` | The client ID of a Rapaport Trade API access key made for KaratOS |
| `RAPNET_CLIENT_SECRET` | That key's client secret. It is sent only to Rapaport's token service, whose address is fixed in the client |

**What it reads.** Each sync signs in machine to machine, reads the Round and Pear lists, and stores a list it hasn't seen before, then the cells that moved in it. Rapaport publishes a new list each Thursday at 11:59 pm Eastern, so a daily sync picks it up the next morning; the other syncs that week read the two lists and stop. A token is renewed five minutes before it expires, and once more if Rapaport rejects it early. A 429 waits as Retry-After says, up to a minute, three times. A 403 stops the sync saying the subscription doesn't include the price list.

The client only sends GETs to the two price list endpoints. RapNet's Instant Inventory isn't read: Rapaport's terms forbid copying listings into another database, so network stones are for live searches, not syncs.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `diamond_price.list_published` | A shape's full list: every cell's carat range, color, clarity, price per carat in US dollars and the day it was priced, with the list's date (its newest cell) | shape, list date and a hash of the cells, so the same list read again is a duplicate and a corrected one is new |
| `diamond_price.list_changed` | The cells that moved in that list, each with its old price and date when Rapaport gives them, and how many rose and fell | the same |

Grades are read as Rapaport writes them, tidied for case and spacing; the grouped grades small sizes are priced in (`D-F`, `IF-VVS`) are kept as groups. A list with a cell that doesn't read is kept but dead-lettered, naming the rows that didn't read, so no price from it is used before a person looks. No department reasons over these events yet.

**Writes.** Declared and turned off: uploading the business's listings to RapNet, and sending a seller an inquiry.

**Testing.** The tests run against a mock built from RapTech's developer pages (`packages/testkit/src/mocks/rapnet.ts`), with made-up prices: the real list is copyrighted and for subscribers only, so no fixture comes near it. It is checked live once a subscriber's access key is connected.
