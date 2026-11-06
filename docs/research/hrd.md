# HRD Antwerp report check

Research for issue #200 (catalog id `hrd`). Checked against HRD Antwerp's own sites on 2026-11-03.

**Step 1 answer: yes, by request.** HRD Antwerp's report portal, MyHRD, has a public API that "allows users to automatically retrieve diamond and jewel report data". Access is requested on an online form that asks for the company's name and VAT number, the reason for using the API, and the name and email of the company's director. So it isn't self-serve: someone at the business has to apply. Move this to Phase 2, or apply now for the pilot store.

| Question | What HRD Antwerp's sites say |
| --- | --- |
| Public API | Yes. The MyHRD portal menu has "API Access", which leads to the request form. API documentation is a PDF linked from that page, which we haven't read yet. |
| Getting access | The request form: your name and email, the company's name and VAT number, why you want the API, and the company director's name and email. No approval process or timeline is described. |
| Cost | Not mentioned. |
| Web lookup | MyHRD has "Find diamond grading report" and "Find jewel grading report" searches over the grading report archive. HRD says a digital copy of every report is kept for ten years. |
| Test environment | Not mentioned. |

**What this means for the connector.** Once approved, it would work like our GIA connector: look up a stone's report by number at intake, so a mismatched stone is caught.

**Still to confirm.** The fields and format the API returns, its auth and limits (from the PDF), and whether there's a cost.

Sources:
- https://my.hrdantwerp.com/
- https://my.hrdantwerp.com/PublicApi/ApiRequest
- https://hrdantwerp.com/faq/
