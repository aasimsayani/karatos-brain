# Birdeye

Research for issue #69 (catalog id `birdeye`). Checked against Birdeye's own help center on 2026-11-03.

**Step 1 answer: yes, for a Birdeye customer.** Birdeye documents a public API at developers.birdeye.com. A business finds its Business ID and API key in its own dashboard under Settings, then Integrations, then API. Birdeye says to contact support if there's no Developers tab. We found no free developer account or sandbox, so this needs the store's own Birdeye subscription. Move this to the next open week if the pilot store uses Birdeye; otherwise, Phase 2.

| Question | What Birdeye's help center says |
| --- | --- |
| Public API | Yes, documented at https://developers.birdeye.com/. Birdeye's help center has guides for embedding reviews, sending review requests and exporting Inbox conversations through it. |
| Getting access | Settings, then Integrations, then API, shows the Business ID and API key. With no Developers tab, contact Birdeye support. |
| Plans and cost | Not stated. |
| Covers the issue's scope | A reviews GET endpoint and review-request automation are both documented. |
| Test environment | None found. |

**Still to confirm.** Auth headers, paging, filtering by date, rate limits and a changelog, all on developers.birdeye.com.

Sources:
- https://support.birdeye.com/en/articles/12654012-how-do-i-embed-reviews-from-birdeye-on-our-business-website-using-the-birdeye-api
- https://support.birdeye.com/en/articles/12653479-how-to-set-up-review-request-automation-using-api
- https://developers.birdeye.com/
