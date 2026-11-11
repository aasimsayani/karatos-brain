### ShipStation

Reads the store's ShipStation shipments and labels: what shipped, how each parcel was insured next to what the customer paid, and its tracking until it arrives, so high-value parcels are watched until delivered and declared values match what was sold.

| Setting | What it is |
| --- | --- |
| `SHIPSTATION_API_KEY` | The account's API v2 key |

**Read-only by design.** ShipStation gives an account one kind of API key, and it has the account's full access: it could also buy labels, which spend the account's postage balance, and void them. ShipStation has no read-only key. So the client is what keeps KaratOS to reading: it sends only GETs of two lists to `https://api.shipstation.com/v2`, with the key in the `API-Key` header and parameters it builds itself from checked values. Buying a label and adding tracking to an order are declared behind the write gate, each needing approval, turned off, and the client has no request to send them.

**What it reads.** ShipStation lists shipments by when they last changed and labels by when they were made, oldest first, 100 a page by number, from a time. The first import reads both from two years back, shipments first. Each later sync reads the shipments changed since the newest change the last one saw, less five minutes, and the labels made in the last 30 days again, since a label's tracking status changes without the label being made again. The first later sync looks back two days for shipments. A record read again unchanged is a duplicate. Each page is one batch, and the checkpoint keeps the list, its start, the next page and the newest change seen, so a resumed sync goes on from that page.

**Events.**
- `shipment.updated` for each shipment: its status, carrier and service, the confirmation asked for and whether it needs a signature, the insurance provider, the insured value of its packages and what the customer paid, and how far the insured value falls short when both are in one currency; the order and shipment numbers, the store and order source, how many packages and items, the skus (up to 20), whether it is a return or a gift, the destination's state and country, and when it ships, was made and last changed.
- `shipment.tracked` for each label, the event the UPS connector gives: the tracking number and carrier, a status every carrier maps to (label created, in transit, delivered or exception), the label's own status and whether it was voided, the service, whether a signature was asked for, the label's and the insurance's cost, the insured value, whether it is a return or international, the destination's state and country, and when it ships and was made.

Each event is keyed by a digest of what was kept. A shipment without an id, a change time or a status, or a label without an id, a creation time or a status, is dead-lettered.

**Privacy.** Names, street addresses, postal codes, phone numbers, email addresses, buyer, gift and internal notes, and label images are never read into an event.

**Rate limits.** ShipStation allows 200 requests a minute. The client waits as `Retry-After` says (up to a minute), or 1, 2 and 4 seconds, on a 429, 500, 502, 503 or 504, before the error goes to the sync runner, which resumes from its checkpoint next time. A 401 says the key is wrong or the plan has no API access; a 403 says the plan doesn't include that list.

**Testing.** API access depends on the account's plan. The tests run against a mock built from ShipStation's developer docs (`packages/testkit/src/mocks/shipstation.ts`). It checks the `API-Key` header, the parameters each list takes, the filters, the sort and the paging. It lists what the first client's key must confirm: that `page_size` goes to 100, how a label's tracking status moves, that amounts are in the currency's units, and the key's shape.
