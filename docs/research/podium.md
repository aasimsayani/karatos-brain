# Podium

Research for issue #68 (catalog id `podium`). Checked against Podium's own developer docs on 2026-11-03.

**Step 1 answer: yes, through an app in Podium's developer portal.** Podium has a public API for conversations, messages, reviews, contacts and payments. To read a store's data, a developer creates an app in the developer portal (developer.podium.com), and Podium issues its client id and secret. The docs describe no partner program or approval step, and they mention Podium test accounts. Move this to the next open week, after confirming how to get a test account.

| Question | What Podium's docs say |
| --- | --- |
| Public API | Yes, `https://api.podium.com`. Its changelog announces new endpoints, such as a summary of all reviews and updating a conversation. |
| Getting access | Create an app in the developer portal. "After Podium receives your app details", it issues the client id and secret. |
| Auth | OAuth 2.0: `https://api.podium.com/oauth/authorize` and `https://api.podium.com/oauth/token`. "Access tokens expire after 10 hours." |
| Scopes | Listed on a separate OAuth scopes page we haven't read yet. |
| Test environment | The docs link to a "Podium Test Accounts" page we haven't read yet. |
| Changelog | https://docs.podium.com/changelog |

**What this means for the connector.** It follows our OAuth pattern, renewing the access token every 10 hours. Conversations are customer messages, so they need masking.

**Still to confirm.** Read-only scopes, refresh token lifetime and rotation, how to get a test account, and rate limits.

Sources:
- https://docs.podium.com/docs/oauth
- https://docs.podium.com/reference/authentication
- https://docs.podium.com/docs/sync-messages-from-podium-conversations
- https://docs.podium.com/changelog/new-endpoints-update-a-conversation-summary-of-all-reviews
