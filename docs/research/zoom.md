# Zoom

Research for issue #180 (catalog id `zoom`). Checked against Zoom's own developer docs on 2026-11-03.

**Step 1 answer: yes.** Zoom has a public REST API, and the store's own account can create a Server-to-Server OAuth app in the Zoom App Marketplace with no partnership. Move this to the next open week. One limit: listing cloud recordings needs a Pro or higher plan.

| Question | What Zoom's docs say |
| --- | --- |
| Public API | Yes, `https://api.zoom.us/v2`. |
| Getting access | A Server-to-Server OAuth app, created in the App Marketplace under Created Apps. It needs a Zoom account with permission to view and edit Server-to-Server OAuth apps, and admin-level role permissions to add admin-level scopes. The app has to be activated before it can get tokens. |
| Auth | `POST https://zoom.us/oauth/token` with the `account_credentials` grant, the account id, and a Basic header holding the client id and secret. A token lasts an hour, and there is no refresh token: the app asks again. |
| Scopes | Chosen on the app's settings page and authorized by account admins. Zoom checks scopes during review, so ask only for what is needed. |
| Plan limits | Listing a user's recordings needs "a Pro or a higher plan". The pages read don't give a plan rule for past meetings or participants. |
| Rate limits | Endpoints are labeled by rate-limit type (for example LIGHT and MEDIUM). Going over answers 429. |
| Webhooks | Yes, as event subscriptions on the app. |
| Changelog | Zoom posts platform announcements at https://developers.zoom.us/docs/platform/announcements/ |

**What this means for the connector.** Server-to-Server OAuth fits our pattern well: no stored refresh token, just the account id, client id and secret, with a token fetched each hour. The meetings, participants and durations in the issue's scope come from the meetings API, and recording metadata needs a Pro plan.

**Still to confirm.** The exact read scopes for past meetings and participants, and whether a free account can activate a Server-to-Server app for the nightly sandbox run.

Sources:
- https://developers.zoom.us/docs/internal-apps/s2s-oauth/
- https://developers.zoom.us/docs/internal-apps/create/
- https://developers.zoom.us/docs/api/meetings/
- https://developers.zoom.us/docs/api/webhooks/
