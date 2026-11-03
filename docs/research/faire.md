# Faire

Research for issue #195 (catalog id `faire`). Checked on 2026-11-03.

**Step 1 answer: an API exists, but not self-serve.** Faire has an external API and a developer portal. Its help center says a brand gets an API key for a custom integration by asking Faire support once the app is built, and that support can't issue keys for apps that haven't been built yet. So there is no free developer account to sign up for, and no sandbox we could find. Move this to Phase 2, or build against Faire's docs and ask for a key when a pilot brand needs it.

| Question | What we found |
| --- | --- |
| Public API | Yes. Faire's External API v2, documented at developers.faire.com. Its older docs site on GitHub Pages now redirects there. |
| Getting access | For a partner integration (such as a store platform), the brand generates a key under Settings, then Integrations. For a custom integration, the brand asks Faire support for a key after the app is built. |
| Cost | Not stated. |
| Test environment | None found. |
| Auth, resources, rate limits, webhooks, changelog | Not confirmed. developers.faire.com builds its pages with JavaScript, so we couldn't read them. These need reading in a browser before building. |

**What this means for the connector.** It can't be built and tested end to end until a brand on Faire asks support for a key. It belongs with the partner-access integrations.

Sources:
- https://www.faire.com/support/articles/37632363832091
- https://developers.faire.com
- https://faire.github.io/external-api-v2-docs (now a redirect)
