# Yotpo reviews and loyalty

Research for issue #185 (catalog id `yotpo`). Checked against Yotpo's own help center and API docs on 2026-11-03.

**Step 1 answer: yes, with the store's own keys.** Yotpo documents REST APIs for reviews (core API) and for loyalty. A store's account administrator gets the keys from its own settings, so no partnership is needed. We found no sandbox, so testing needs a Yotpo account. Move this to the next open week once a test account is in hand.

| Question | What Yotpo's docs say |
| --- | --- |
| Public API | Yes. A reviews and UGC API (core API, with v1 and v3 docs) and a separate Loyalty API. |
| Reviews keys | The app key (also called the Store ID) is at the bottom of Account Settings, then General Settings. The secret key has to be generated there ("Get secret key") with a code Yotpo emails to the account address. Only the account administrator can see it. |
| Loyalty keys | A GUID and an API key from the Loyalty settings, sent as the `X-GUID` and `X-API-KEY` headers. |
| Plans | The key article lists "All plans" for Reviews, Loyalty and Referrals, and Visual UGC. It doesn't say whether a free account gets API access. |
| Test environment | None found. |

**What this means for the connector.** It needs two credential sets, one for reviews and one for loyalty, so the settings and the manifest should name both. Like our Yext connector, it should keep no reviewer name or email.

**Still to confirm.** Read scopes and whether a token can be limited to reading, rate limits, filtering by update date, and API access on a free account.

Sources:
- https://support.yotpo.com/docs/finding-your-yotpo-app-key-and-secret-key
- https://apidocs.yotpo.com/reference/yotpo-authentication
- https://loyaltyapi.yotpo.com/reference/authentication
