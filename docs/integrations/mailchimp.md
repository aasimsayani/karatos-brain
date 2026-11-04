### Mailchimp

Reads one Mailchimp account through the Marketing API (3.0) on the data center its API key names. A Mailchimp API key can't be limited to reading, so read-only is enforced in the client: it sends GET requests for five listed reads only (ping, audiences, audience members, campaigns and campaign reports), with parameters it checked, and throws before sending anything else. The one write it may do later (add a contact to an audience) is declared and stays behind the write gate.

| Setting | What it is |
| --- | --- |
| `MAILCHIMP_API_KEY` | An API key from Profile > Extras > API keys, ending in the account's data center (such as `-us21`) |
| `CUSTOMER_REF_KEY` | The instance's customer reference key, shared with custom forms, Calendly and Klaviyo |
| `MAILCHIMP_WEBHOOK_SECRET` | Optional. A random secret for the webhook URL, for when webhooks are turned on |

**Privacy.** Every read names the fields it wants (`fields=`), so names, phone numbers, addresses, birthdays, merge fields, tags, locations and subject lines never leave Mailchimp. A member's email address comes back only to become the same keyed reference custom forms makes for it, so a subscriber lines up with the same person's form submissions, Calendly bookings and Klaviyo profile. Mailchimp's member id is the MD5 of the email address, which anyone can recompute from a guess, so it is never kept.

**What it reads.** The historical import reads every audience, every member of each (1000 a page, oldest change first), and the campaigns sent in the last five years with each one's report. Incremental syncs read the audiences again, the members changed since the previous pass started (less five minutes), and the campaigns sent from 30 days before that, since a report keeps growing as opens and clicks come in.

**Rate limits.** Mailchimp allows 10 requests at once. The client sends one at a time and waits out a 429 (`Retry-After` when sent, at most a minute, three tries) before the error goes to the sync runner.

**Events.** The same types as Klaviyo: `marketing.list_updated` for audiences, `customer.profile_updated` with `marketingConsent` true only for subscribed members, `marketing.group_membership_seen`, `marketing.campaign_updated`, `marketing.campaign_metrics_reported` with sends, bounces, opens, clicks, orders, revenue in cents, unsubscribes and abuse reports, and marketing's `campaign.sent` once emails went out (cost 0, as Mailchimp has none per campaign). Members are keyed by audience, reference and last change, and reports by a digest of their numbers, so a replay is a duplicate.

**Webhooks.** Mailchimp doesn't sign deliveries. `verifyMailchimpWebhook` checks the `key` query parameter the instance put in the webhook URL against `MAILCHIMP_WEBHOOK_SECRET`, in constant time. `mailchimpWebhookEvent` reads a delivery's type, audience and time from its form body and nothing about the member. A delivery is a prompt to sync. The instance doesn't take webhooks yet; the scheduled sync picks every change up.

**Testing.** The tests run against a mock built from Mailchimp's docs (`packages/testkit/src/mocks/mailchimp.ts`), which needs Basic auth, applies `fields`, filters by `since_last_changed` and `since_send_time`, sorts and pages. For the nightly run, make a free Mailchimp account with one audience of `example.test` addresses and a test campaign, and add its key as the `SANDBOX_MAILCHIMP_API_KEY` GitHub Actions secret.
