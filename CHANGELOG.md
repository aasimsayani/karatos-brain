# Changelog

## 0.1.0 (2026-10-02)

Public rebuild of Brain A from scratch, based on the original v0.1.x design docs.

- Seven-layer contracts (`Normalizer`, `SignalExtractor`, `MemoryStore`, `Reasoner`, `DocumentationSource`) and `BrainPipeline`
- Validated event envelope with idempotent ingestion
- Recommendations always carry provenance and are marked degraded when documentation is stale
- In-memory store for tests and local use
- Jewelry math: karat purity and melt value
- Config validation where only Supabase and the organization id are required
- Secret scanning, CI, MIT license and open-core strategy doc
