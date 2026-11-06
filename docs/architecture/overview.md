# Architecture overview

Brain A is the core intelligence engine for Fuse Jewelry and KaratOS. It has seven mandatory layers. Each layer has a TypeScript contract in `packages/core/src/layers.ts`, and `BrainPipeline` wires them together in a fixed order.

| # | Layer | Contract | Rule |
| --- | --- | --- | --- |
| 1 | Event Ingestion | `EventEnvelopeSchema` | Validate and store every event before any transformation. Replays with the same idempotency key are ignored. |
| 2 | Entity Normalization | `Normalizer` | Map source records onto canonical entities. |
| 3 | Signal Extraction | `SignalExtractor` | Every signal lists the event ids it came from. |
| 4 | Memory + State | `MemoryStore` | Events are append-only. Entities are upserted. |
| 5 | Reasoning | `Reasoner` | Every recommendation carries confidence, expected impact and provenance, and a dollar `impact` where there is an honest way to put a number on it. |
| 6 | Feedback + Learning | `Feedback` | Human overrides are recorded, not discarded. |
| 7 | Documentation | `DocumentationSource` | Stale docs force `degraded: true` on every recommendation. |

## Data flow

```
source system ──► ingest() ──► validate ──► MemoryStore.appendEvent
                                              │ (duplicate? stop)
                                              ▼
                                    Normalizers ──► upsertEntities
                                              ▼
                                    SignalExtractors ──► appendSignals

reason(org) ──► DocumentationSource.current()
            ──► MemoryStore.recentSignals
            ──► Reasoners ──► saveRecommendations
```

## Supporting pieces

| Piece | Where | What it guarantees |
| --- | --- | --- |
| Dead letters | `DeadLetteredError`, `dead_letter_events` | Invalid input is kept for repair and replay, never silently dropped |
| Identity resolution | `linkIdentity`, `identities` | One real-world customer or product is one entity across all sources. Collisions raise an error instead of merging. |
| Connectors | `Connector`, `runSync`, `sync_checkpoints` | Historical import, incremental sync, retries and checkpoints behave the same for every source |
| Reasoning runs | `reasoning_runs` | Every reasoning pass records its reasoners, documentation state and output |
| Decisions and outcomes | `decisions`, `outcomes` | What people chose, and what happened next, to calibrate confidence |
| Memories | `memories` | Long-lived, text-searchable knowledge about the business |
| Documentation registry | `RegistryDocumentationSource`, `documentation_registry` | Drift in the source-of-truth docs marks reasoning degraded |
| Connections | `PostgresIngestionLog`, `integration_connections` | Which systems an instance has connected, their streams and status. Stores secret names only; a check rejects anything shaped like a secret value. |
| Sync runs | `sync_runs` | Every historical import, incremental sync, webhook batch and file import, with counts, cursors and errors. A failed run marks its connection as erroring. |
| Webhook deliveries | `webhook_deliveries` | A vendor's retried delivery is processed once |
| File imports | `file_imports` | Bank and card statements (CSV or PDF) and other uploads. The same file uploaded twice is one import, keyed by SHA-256. |
| Entity links | `entity_links` | How entities relate (an order's customer, a repair's product), readable in both directions |
| Write audit | `write_audit` | `PostgresIngestionLog` is a `WriteAuditLog`, so every write attempt, refusals included, is kept. Append-only. |
| Retention runs | `retention_runs`, `purgeRawData` | Raw vendor data is cleared after `RAW_RETENTION_DAYS` (default 30) while facts, signals and source references stay. Every purge is recorded. Append-only. |
| Careful write-back | `SafeWriter`, `WriteTarget` | A write to a client's system is checked for policy, shape, approval, idempotency, a daily cap and a fresh precondition before it is sent, and read back after. A mismatch turns off that integration's writes. See [careful write-back](write-back.md). |

All of these tables have row-level security keyed on the organization, and the migration ledger (`schema_migrations`) has row-level security with no policy, so only the service role can touch it.

Brain A keeps a slim copy: cleaned-up facts and signals with a link back to each source record, and raw vendor data only for 30 days. See [data retention](data-retention.md).

See [why Brain A compounds in value](../vision/compounding-value.md) and the [incident runbook](../runbooks/incidents.md).

## Multi-tenancy

Every record carries an `organizationId`. Fuse Jewelry is the first organization. Other jewelers run as separate organizations on the same core.
