# Architecture overview

Brain A is the core intelligence engine for Fuse Jewelry and KaratOS. It has seven mandatory layers. Each layer has a TypeScript contract in `packages/core/src/layers.ts`, and `BrainPipeline` wires them together in a fixed order.

| # | Layer | Contract | Rule |
| --- | --- | --- | --- |
| 1 | Event Ingestion | `EventEnvelopeSchema` | Validate and store every event before any transformation. Replays with the same idempotency key are ignored. |
| 2 | Entity Normalization | `Normalizer` | Map source records onto canonical entities. |
| 3 | Signal Extraction | `SignalExtractor` | Every signal lists the event ids it came from. |
| 4 | Memory + State | `MemoryStore` | Events are append-only. Entities are upserted. |
| 5 | Reasoning | `Reasoner` | Every recommendation carries confidence, expected impact and provenance. |
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

## Multi-tenancy

Every record carries an `organizationId`. Fuse Jewelry is the first organization. Other jewelers run as separate organizations on the same core.
