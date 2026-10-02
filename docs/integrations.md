# Integrations

The catalog lives in code at [`packages/core/src/integrations.ts`](../packages/core/src/integrations.ts), carried over from the original Brain A Integration Mapping sheet. A test checks that every setting an integration needs is documented in [`secrets/manifest.json`](../secrets/manifest.json).

| Integration | Domain | History | Status |
| --- | --- | --- | --- |
| Shopify | E-commerce | 5 years | Planned |
| Inventory and POS systems | E-commerce | 5 years | Planned (CSV first) |
| Stripe | Financial | 5 years | Planned |
| Chase bank and credit cards | Financial | 6 years | Planned (manual CSV; PDF statements later) |
| HubSpot | CRM | 5 years | Planned |
| Monday.com | CRM | 5 years | Planned |
| Custom forms | CRM | 5 years | Planned |
| Gmail | Communication | 5 years | Planned |
| Google Workspace and Drive | Documents | 5 years | Planned |
| Slack | Communication | 5 years | Planned |
| Instagram, Messenger and WhatsApp | Communication | 5 years | Deferred until the Facebook account is recovered |
| Claude (Anthropic API) | Reasoning | n/a | Planned |

## The connector contract

Every connector implements `Connector` from `@karatos/core`:

- `historicalImport(context)` and `incrementalSync(context)` yield batches of raw records, each with a cursor.
- `handleWebhook(body)`, where the source supports webhooks, turns one delivery into raw records. Verify the signature first.

`runSync` does the rest, so every connector gets the same guarantees:

- The checkpoint advances only after a whole batch is stored, so a crash resumes from the last good batch.
- Source errors are retried with backoff by restarting from the checkpoint. Brain A's own errors are not retried.
- Invalid records are dead-lettered and counted, and never stop the sync.
- Replays are counted as duplicates and stored once.
- Every record is stamped with the instance's organization and the connector's source.
