# One instance per client

Brain A is open source, but every client's data lives in a deployment of its own. Fuse Jewelry is the first client and gets the first instance.

## What an instance is

| Piece | One per client | Why |
| --- | --- | --- |
| Supabase project | Yes | Separate database, backups, keys and bills. One client's breach or mistake can't reach another. |
| Running container | Yes | The `karatos-brain` image, started with that client's settings. |
| `ORGANIZATION_ID` | Yes | Stamped on every row. The API refuses events for any other organization. |
| `INSTANCE_API_KEY` | Yes | Only that client's agents and connectors can call the instance. |
| Private instance repo | Yes | Holds the client's deploy settings and custom modules. Never holds secret values. |
| Code | Shared | Every instance runs the same public image, so a fix ships to everyone. |

Isolation is layered. A request needs the right API key. Every event is pinned to the instance's organization, and Postgres row-level security filters every table by organization. On top of that, each client has a physically separate database.

```
                    public repo: aasimsayani/karatos-brain
                    └── image: ghcr.io/aasimsayani/karatos-brain
                                 │
             ┌───────────────────┴───────────────────┐
             ▼                                       ▼
  Fuse Jewelry instance                    Next client's instance
  ├── private repo: fuse-jewelry-brain     ├── private repo: <client>-brain
  ├── container  (ORGANIZATION_ID=fuse-jewelry)    ├── container
  ├── Supabase project: fuse-jewelry-brain ├── Supabase project
  └── secrets in the host's secret store   └── secrets in the host's secret store
```

## Setting up a new client

1. **Create the client's Supabase project.** Name it `<client>-brain` and save the database password in your password manager.
2. **Create a private repo** from [`deploy/instance-template`](../../deploy/instance-template), named `<client>-brain`.
3. **Collect the settings.** In a checkout of this repo, run:
   ```bash
   cp .env.example .env.local
   npm run secrets:setup
   ```
   The tool generates the keys it can (API key, webhook secret) and walks you through the rest one at a time, with where to find each value. See [secrets](../secrets.md).
4. **Create the tables:** `npm run db:migrate`. The instance also does this on start when `MIGRATE_ON_START=true`.
5. **Deploy the image** to your host with the same settings in its secret store, and check `GET /healthz`.
6. **Hand out the API key** only to that client's agents and connectors.

## Calling an instance

```bash
curl -X POST https://<instance-host>/v1/events \
  -H "Authorization: Bearer $INSTANCE_API_KEY" \
  -H "content-type: application/json" \
  -d '{"id":"evt_1","source":"manual","type":"order.created",
       "occurredAt":"2026-10-01T12:00:00Z","receivedAt":"2026-10-01T12:00:01Z",
       "idempotencyKey":"order-1001","payload":{"orderId":"1001"}}'
```

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /healthz` | None | Liveness check |
| `POST /v1/events` | API key | Ingest one event. Returns 202, or 200 for a replay with the same idempotency key, or 403 if the event names another organization |
| `POST /v1/reason` | API key | Run the reasoners and return recommendations |

## Choosing a host

The image runs anywhere that runs Docker containers. Pick the host once, and use it for every client so the runbook stays the same. Railway, Fly.io and Google Cloud Run all work: each gives a secret store, HTTPS and health checks.
