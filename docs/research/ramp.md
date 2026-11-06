# Ramp

Research for issue #212 (catalog id `ramp`). Checked against Ramp's own API docs on 2026-11-03.

**Step 1 answer: yes.** Ramp has a public developer API with read-only scopes for everything in the issue's scope, and a separate demo (sandbox) environment. A business creates an app in its own Ramp Developer settings and uses the client credentials grant for its own account. Move this to the next open week.

| Question | What Ramp's docs say |
| --- | --- |
| Public API | Yes, the Ramp Developer API (v1). |
| Getting access | Create an app in the Ramp Developer settings (app.ramp.com/settings/ramp-developer). The docs don't say which Ramp roles can. |
| Auth | Client credentials, for "server-to-server integrations with your own Ramp business"; tokens last 10 days. The authorization code grant is for apps other businesses connect; its tokens last an hour unless set otherwise, and a refresh token needs the refresh grant turned on. Tokens come from `<environment>/developer/v1/token` with the client id and secret, usually in a Basic header. |
| Read scopes | `transactions:read`, `receipts:read`, `reimbursements:read`, `bills:read`, `vendors:read` and `users:read`, which match the issue's scope exactly. |
| Test environment | A demo environment: the app at demo.ramp.com and the API at `https://demo-api.ramp.com`, needing an app of its own. It can't move real money. The pages read don't say how to get a demo account. |
| Webhooks | Documented. |
| Changelog | https://docs.ramp.com/developer-api/v1/changelog |

**What this means for the connector.** Read-only scopes mean the connector can ask Ramp for exactly what it reads, the way our Pinterest and TikTok connectors check their scopes. Client credentials need no stored refresh token.

**Still to confirm.** How to get a demo account, and the rate limits.

Sources:
- https://docs.ramp.com/developer-api/v1/overview/scopes
- https://docs.ramp.com/llms-guides/sandbox.txt
- https://docs.ramp.com/llms-full.txt
- https://docs.ramp.com/developer-api/v1/webhooks
