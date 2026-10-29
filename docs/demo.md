# The demo store

`packages/demo` is Example Street Jewelers, a made-up store that runs on the real connectors and the real brain. It powers the public demo dashboard at karatos.app/demo. Nothing in it is a mock of the dashboard. Each system's data goes through that system's connector, into the retail departments and out as recommendations and signals, the same way it does on a client's instance. When a connector or a department changes, the demo changes with it.

## What the store runs on

| System | Connector | What it gives the dashboard |
| --- | --- | --- |
| Metals-API | `metals_api` | Spot prices. Gold is up 6% today, so pieces heavy in gold need repricing |
| POS exports | `inventory_pos` | The case, customers and two years of sales: aged stock, pieces to reorder, a chain that keeps coming back, a $14,900 cash sale that needs a Form 8300, cash payments to review under the AML program, and a lapsed customer who spent over $5,000 |
| Plaid | `plaid` | Bank balances and transactions. The cash deposits don't cover the cash the drawer took in |
| QuickBooks | `quickbooks` | Invoices to trade accounts. $4,650 is more than 30 days past due |
| Twilio | `twilio` | The phone line. Two callers didn't get through and nobody called them back |
| WatchSearch | `watchsearch` | Two WhatsApp dealer groups. Three dealers are looking for the same Rolex |

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

The demo runs in its own Railway project, apart from every client's instance and from the site:

1. A `demo-store` service built from this repo with `packages/demo/Dockerfile`. Generate `DEMO_API_KEY` in Railway. It needs no public domain, because only the console calls it, over Railway's private network.
2. A `demo-console` service from the private console image, in demo mode, pointed at `demo-store` and referencing the same `DEMO_API_KEY`.
3. The site's own service gets the `demo-console` service's address, so karatos.app/demo is served from it.

The console's demo mode and the site's /demo route are separate changes.
