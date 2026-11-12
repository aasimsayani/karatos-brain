# The demo store

`packages/demo` is Example Street Jewelers, a made-up store doing about $4 million a year that runs on the real connectors and the real brain. It powers the public demo dashboard at karatos.app/demo. Nothing in it is a mock of the dashboard. Each system's data goes through that system's connector, into the retail departments and out as recommendations and signals, the same way it does on a client's instance. When a connector or a department changes, the demo changes with it.

## The size of the store

The store carries about 200 lines in its case (some 740 pieces on hand, about $3 million at cost), sells to nearly 290 customers, and has rung up about 1,300 sales in the last year, plus 70 repair tickets. Two layers make it up:

- **The story** (`packages/demo/src/store.ts`): a few pieces, customers, sales and tickets, each chosen to show one problem on the dashboard.
- **The everyday store** (`packages/demo/src/bulk.ts`): the rest of the case, the regular customers, a year of card and financing sales and the repairs that go out on time. It is made by a seeded generator, so it is the same on every seed, and it follows rules that keep it from raising anything on its own: every piece sold in the last 120 days and has at least 2 left, returns stay under one in four, regulars bought in the last year by card or financing, and repairs are collected or still ahead of their promised date. A test checks no recommendation names an everyday piece, customer or ticket, so the problems still have to be found among normal business.

Card settlements in the bank are worked out from the week's card and financing sales, less a 2.9% fee, so the bank and the POS agree.

## What the store runs on

| System | Connector | What it gives the dashboard |
| --- | --- | --- |
| Metals-API | `metals_api` | Spot prices close to the real market (gold about $4,040 an ounce in November 2026). Gold is up 6% today, so pieces heavy in gold need repricing |
| POS exports | `inventory_pos` | The case, customers, two years of sales and the repair envelopes: aged stock, pieces to reorder, a chain that keeps coming back, a $14,900 cash sale that needs a Form 8300, cash payments to review under the AML program, two lapsed customers who spent over $5,000, diamond studs selling faster than they're restocked, a ring sizing five days late, an estate brooch overdue from the setter, a chain and a watch waiting for pickup, and a pearl restring unclaimed for 240 days |
| Supplier invoices and memos | `supplier_invoices` | A loose diamond on a 45-day memo that sold three days ago, so the vendor is owed $8,200 before it asks, and the memo carries no System of Warranties statement |
| Plaid | `plaid` | Bank balances and transactions. The cash deposits don't cover the cash the drawer took in |
| QuickBooks | `quickbooks` | Invoices to trade and corporate accounts. $7,050 across 3 invoices is more than 30 days past due |
| Twilio | `twilio` | A busy week on the phone line. Two callers didn't get through and nobody called them back |
| WatchSearch | `watchsearch` | Two WhatsApp dealer groups. Three dealers are looking for the same Rolex |

The brain reasons over the last 20,000 signals (`DEMO_REASONING_WINDOW`), well above all the demo store makes, so the earliest sources still count. Seeding the whole store takes well under a second.

The dashboard shows 23 recommendations.

Every other built connector is listed in `DEMO_NOT_YET` (`packages/demo/src/sources/index.ts`) with the reason it isn't in the demo yet. A test fails when a connector is built but neither runs in the demo nor is listed there. Another test removes each source in turn and checks that something disappears from the dashboard, so no source is there for show.

## Made-up data

Every name, number and amount is invented. Emails use reserved test domains, and phone numbers sit in the 555-0100 to 555-0199 range kept for fiction. A test runs the testkit's `assertSynthetic` over the data and over every recommendation. Dates are counted back from the day the demo is seeded, so the dashboard always reads as this week. The brain reasons on the same calendar, and a test seeds on several days, including a leap day, and checks the story stays the same.

Never copy a client's records into the demo, even with the names changed.

## The service

`npm run build -w @karatos/demo` then `node packages/demo/dist/main.js` serves the instance API (`/v1/recommendations`, `/v1/signals`, `/v1/integrations`, `/v1/entities/...`) over the demo store, held in memory. It needs `DEMO_API_KEY`, at least 32 random characters, and reads `PORT` (default 8080).

- It is read-only. `POST /v1/events` and `POST /v1/reason` are turned down with 403, so a visitor can't change what others see.
- Accept and Dismiss are recorded as feedback, up to 2,000 a day. Past that the API answers 429 until the reset.
- Every midnight UTC it seeds a fresh copy and swaps it in, which moves the dates on and clears the day's feedback. If a reseed fails, the old copy keeps serving and the next night tries again.
- `/v1/integrations` marks the store's systems as connected and adds a `demo` field to each with what the store uses it for, how many records came in, and when it synced.

The image is `packages/demo/Dockerfile`, built from the repo root. CI builds it, starts it and checks it answers with at least 10 recommendations.

## Hosting

The demo runs as two services in the website's Railway project, apart from every client's instance. They share the website's project because Railway's private network stops at the project, and the website has to reach the console over it:

1. A `demo-store` service built from this repo with `packages/demo/Dockerfile` (`RAILWAY_DOCKERFILE_PATH=packages/demo/Dockerfile`, `PORT=8080`). Generate `DEMO_API_KEY` in Railway. It needs no public domain, because only the console calls it.
2. A `demo-console` service from the console repo in demo mode: `CONSOLE_DEMO=true`, `BASE_PATH=/demo`, `STORE_NAME=Example Street Jewelers`, `PORT=8080`, `INSTANCE_URL=http://demo-store.railway.internal:8080` and `INSTANCE_API_KEY=${{demo-store.DEMO_API_KEY}}`. It needs no public domain either.
3. The website service gets `DEMO_CONSOLE_URL=http://demo-console.railway.internal:8080`, so karatos.app/demo is served from the console ([docs/website.md](website.md#live-demo)).

The console's demo mode and the site's /demo route are separate changes.
