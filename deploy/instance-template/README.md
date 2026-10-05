# <client>-brain

Private deployment repo for one Brain A client. Copy this folder into a new **private** repo named after the client, for example `fuse-jewelry-brain`.

This repo holds the client's **non-secret** settings and deploy notes. Secret values never go here. They live in the host's secret store, described in [docs/secrets.md](https://github.com/aasimsayani/karatos-brain/blob/main/docs/secrets.md).

## Files

| File | Purpose |
| --- | --- |
| `instance.env` | Non-secret settings: `INSTANCE_NAME`, `ORGANIZATION_ID`, `ENABLED_INTEGRATIONS`, `ENABLED_DEPARTMENTS`, `DOC_REGISTRY_IDS` |
| `IMAGE` | The exact `ghcr.io/aasimsayani/karatos-brain` tag this client runs. Bump it to upgrade. |

## Upgrading

1. Read the public repo's `CHANGELOG.md` for the new version.
2. Change `IMAGE` to the new tag in a PR.
3. Deploy, then check `GET /healthz`.
