# Quo (formerly OpenPhone)

Research for issue #179 (catalog id `openphone`). Checked against Quo's own docs and help center on 2026-11-03.

**Step 1 answer: yes.** Quo has a public REST API on every plan. A workspace Owner or Admin creates an API key in the workspace settings, with no partnership and no monthly API fee (sending texts costs a cent a segment from prepaid credits, and reading costs nothing extra). There is no separate sandbox, so testing uses a Quo workspace. Move this to the next open week.

| Question | What Quo's docs say |
| --- | --- |
| Public API | Yes, `https://api.quo.com`. |
| Getting access | "Active Quo subscription (any plan)" and "Owner or Admin permissions for your workspace". The key is created in the workspace settings and can be regenerated. |
| Auth | The key goes in the `Authorization` header. |
| Calls | `GET /v1/calls` needs `phoneNumberId` (a "PN…" id) and one `participants` number, so calls are listed per conversation, not for the whole workspace at once. It filters by `createdAfter` and `createdBefore`, up to 100 a page, with `pageToken`. Quo notes that `totalItems` isn't reliable. |
| Transcripts and messages | Separate endpoints for a call's transcription, for messages and for conversations, and a webhook for new transcripts. |
| Cost | No monthly API fee. Messages cost $0.01 a segment in the US and Canada, from prepaid credits. |

**What this means for the connector.** Since calls are listed one participant at a time, the connector should list conversations first, then read each one's calls and messages. Transcripts and recordings are customer conversations, so they need the same masking as our other message connectors.

**Still to confirm.** Rate limits, and whether transcripts need a particular plan.

Sources:
- https://support.quo.com/core-concepts/integrations/api
- https://www.quo.com/docs/mdx/api-reference/authentication
- https://www.quo.com/docs/mdx/api-reference/calls/list-calls
- https://www.quo.com/docs/mdx/api-reference/calls/get-a-transcription-for-a-call
- https://www.quo.com/docs/mdx/api-reference/conversations/list-conversations
