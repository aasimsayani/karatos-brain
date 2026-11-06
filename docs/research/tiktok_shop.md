# TikTok Shop

Research for issue #194 (catalog id `tiktok_shop`). Checked on 2026-11-03.

**Step 1 answer: not confirmed, so treat it as partner access.** TikTok Shop documents a Seller API, including an order list endpoint, on its Partner Center. Every Partner Center page we tried builds its content with JavaScript and came back empty, though, so we couldn't confirm who can register an app, whether app review is needed, or whether a test shop exists. The catalog already marks TikTok Shop as partner access. Keep it in Phase 2 until someone reads the Partner Center in a browser.

| Question | What we found |
| --- | --- |
| Public API | The Partner Center lists a Seller API overview, an API concepts overview, "Get Order List" (version 202309), "Get Seller Permissions" and a "Test your App" page. |
| Getting access, auth, test shop, cost | Not confirmed: the pages need JavaScript. |
| Related | Our TikTok connector (the store's own account and videos) uses TikTok's separate Display API. A TikTok Shop connector would need its own Partner Center app. |

**Next step.** Someone opens the "Test your App" and "Overview" pages in a browser and notes who can register, whether a sandbox shop exists, and the app review rules.

Sources:
- https://partner.tiktokshop.com/docv2/page/tts-api-concepts-overview
- https://partner.tiktokshop.com/docv2/page/650b1f2ff1fd3102b93c6d3d
- https://partner.tiktokshop.com/docv2/page/get-order-list-202309
- https://partner.tiktokshop.com/docv2/page/64f1998564ed2e0295f3d87d
