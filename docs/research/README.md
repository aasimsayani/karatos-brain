# Integration research

Each page here answers the first step of an integration issue marked `needs-research`: does the vendor have a public API, and can we get a free developer account or test environment without asking anyone? The answer decides where the issue goes. With self-serve access, it moves to the next open week. Without it, it moves to Phase 2.

Every claim on these pages comes from the vendor's own docs or help center, linked at the bottom of each page with the date it was checked. Where the docs didn't say, the page says "not stated" or "not confirmed" rather than guessing. Vendors change their terms, so confirm the access details when signing up.

| Vendor | Issue | Public API | Self-serve access | Test environment | Where it goes |
| --- | --- | --- | --- | --- | --- |
| [Etsy](etsy.md) | #94 | Yes | Yes: a seller app for the store's own shop | None described | Next open week |
| [Lightspeed Retail (X-Series)](lightspeed.md) | #62 | Yes | Yes: a developer account, up to 30 stores without approval | Trial store | Next open week |
| [Klarna](klarna.md) | #216 | Yes | Yes: test account sign-up | Playground | Next open week |
| [Ramp](ramp.md) | #212 | Yes | Yes: an app in the business's own Ramp | Demo environment | Next open week |
| [Zoom](zoom.md) | #180 | Yes | Yes: a Server-to-Server OAuth app | The store's own account | Next open week |
| [Quo (OpenPhone)](openphone.md) | #179 | Yes | Yes: an API key on any plan | The store's own workspace | Next open week |
| [Deputy](deputy.md) | #219 | Yes | Yes: the customer's own OAuth or permanent token | Not stated | Next open week |
| [Podium](podium.md) | #68 | Yes | Yes: an app in Podium's developer portal | Podium test accounts (not yet read) | Next open week |
| [Judge.me](judgeme.md) | #186 | Yes | Yes: the store's private token | The store's own account | Next open week |
| [Yotpo](yotpo.md) | #185 | Yes | Yes: the store's own keys | None found | Next open week |
| [Birdeye](birdeye.md) | #69 | Yes | For a Birdeye customer | None found | Next week if the pilot store uses it |
| [Formlabs](formlabs.md) | #97 | Yes | Yes: credentials in the Formlabs Dashboard | A real account with a connected printer | Next open week |
| [NuORDER](nuorder.md) | #196 | Yes | For a brand on NuORDER: keys in API Management | A sandbox host, no sign-up described | Next week if the pilot wholesaler uses it |
| [HRD Antwerp](hrd.md) | #200 | Yes | No: an access request form | Not mentioned | Phase 2, or apply for the pilot |
| [IGI](igi.md) | #66 | A developer portal now exists | Not confirmed: sign-up didn't load | Not known | Phase 2 until someone signs up |
| [GCAL](gcal.md) | #201 | Not found | Not confirmed: the site couldn't be read | Not known | Phase 2 |
| [RepairShopr](repairshopr.md) | #256 | Yes | For a RepairShopr account: an API key from the Admin Center | None found | Next week if the pilot store uses it |
| [Art Loss Register](art_loss_register.md) | #237 | No | Manual paid searches only | None | Phase 2 |
| [TaxJar](taxjar.md) | #85 | Yes | The API, yes; the sandbox needs the Professional plan | Professional plan only | Phase 2 |
| [Katana](katana.md) | #214 | Yes | Needs the Professional plan | None found | Phase 2 |
| [Faire](faire.md) | #195 | Yes | No: a key comes from Faire support after the app is built | None found | Phase 2 |
| [Attentive](attentive.md) | #70 | Yes, but write-only scopes | An API key, yes; nothing to read subscribers or metrics with | Not mentioned | Phase 2 |
| [TikTok Shop](tiktok_shop.md) | #194 | Documented | Not confirmed: the docs need JavaScript | Not confirmed | Phase 2 |

## Adding a page

Name the page after the catalog id in `packages/core/src/integrations.ts`. Open with the issue number and the date checked, then the one-line answer to step 1, then a table of what the vendor's docs say. List what is still to confirm, and end with the source links. Add a row to the table above.
