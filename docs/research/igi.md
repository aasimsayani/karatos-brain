# IGI report verification

Research for issue #66 (catalog id `igi`). Checked on 2026-11-03.

**Step 1 answer: an IGI developer portal now exists, which changes the catalog note.** The catalog says "Web lookup only; no API found", but IGI now runs a developer portal (developer.igi.org) that says it "provides access to IGI's APIs", with a sign-up link. Its API list shows nothing without signing in, and the sign-up page didn't load for us, so we couldn't confirm what the APIs return or who can get access. The web lookup at igi.org ("Verify Your Report") still works by report number. Keep this in Phase 2 until someone signs up and reads the API list.

| Question | What we found |
| --- | --- |
| Public API | A developer portal exists. Its APIs page lists nothing until you sign in. |
| Getting access | A "Sign up" link to an igi.org tools access page, which answered with an error when we tried it. Cost and approval aren't stated. |
| Web lookup | IGI's "Verify Your Report" page checks a report by number. |
| Test environment | Not known. |

**Next step.** Sign up on developer.igi.org with the store's details, read the API list, and update this page and the catalog note.

Sources:
- https://developer.igi.org/
- https://developer.igi.org/apis
- https://www.igi.org/Verify-Your-Report/
