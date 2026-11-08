### Docusign

Reads Docusign's eSignature REST API (`/restapi/v2.1`) for one account: its envelopes, each with its recipients, so a store can see that every consignment and memo agreement is signed and chase the ones that aren't. It signs in with JWT Grant, as a server does, so nobody has to sign in again.

| Setting | What it is |
| --- | --- |
| `DOCUSIGN_INTEGRATION_KEY` | The integration key of the KaratOS app in Settings > Apps and Keys |
| `DOCUSIGN_PRIVATE_KEY` | The app's RSA private key, as Docusign shows it or base64-encoded on one line. It only signs the sign-in and is sent nowhere |
| `DOCUSIGN_USER_ID` | The API user id of the user the connector signs in as: one with the Viewer permission profile, which can't send, and shared access to the senders' envelopes |
| `DOCUSIGN_ACCOUNT_ID` | The API account id whose envelopes are read |
| `DOCUSIGN_ENVIRONMENT` | Optional. `production` (the default) or `developer` for a developer account |
| `DOCUSIGN_CONNECT_HMAC_KEYS` | Optional. The Connect configuration's HMAC keys, separated by commas, once Connect is turned on |
| `CUSTOMER_REF_KEY` | Keys the customer references made from recipients' email addresses |

**Connecting.** Add an app named KaratOS in Settings > Apps and Keys, generate its RSA key pair under Service Integration, and add one redirect URI for the consent step. Add a KaratOS user with the Viewer permission profile and give it shared access to the envelopes of each person who sends agreements. Then sign in once as that user at `https://account.docusign.com/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=<integration key>&redirect_uri=<the redirect URI>` (`account-d.docusign.com` for a developer account) and accept, which gives the consent JWT Grant needs. Until then the sync stops saying the user hasn't consented.

**Read-only.** Docusign has no read-only scope: JWT Grant asks for `signature impersonation`, which every eSignature call needs, reads and sends alike. So it is the signed-in user that can't send, through its Viewer profile, and the client sends only three requests: the token request (`POST /oauth/token` on the sign-in host), `GET /oauth/userinfo` to find the account's API address, and `GET /accounts/{accountId}/envelopes`. The API address must be an https `docusign.net` address, and the account must be one the user belongs to. It never downloads a document. Sending an envelope is declared behind the write gate, and the test shows it is stopped.

**What it reads.** Each envelope's status, its kind, its created, sent, delivered, completed, declined, voided and deleted times, and each recipient's role, routing order, status and sent, delivered, signed and declined times. The kind (consignment, memo, appraisal, custom order, repair, purchase, sale, layaway, employment, confidentiality, vendor or other) is read from the email subject, which isn't kept, since it often names the customer. A recipient's email address only makes a keyed customer reference, the same one custom forms, Calendly and Klaviyo make, so a signed memo links to the same person's other records; the address isn't kept. Names, phone numbers, messages, decline reasons, field values and documents never are. At most 100 recipients are kept per envelope.

The first import reads envelopes whose status changed in the last five years, 100 a page, oldest change first. Each later sync asks only for envelopes changed since the last pass started, less five minutes of overlap, and then reads every envelope still out for signature, since a recipient viewing or signing doesn't always change the envelope's own status. Each batch's checkpoint keeps the latest status change read, so a resumed sync asks again from there and envelopes read twice are duplicates. Docusign asks apps to read an envelope at most once every 15 minutes, so don't schedule the sync more often than that. A token lasts an hour and a new one is asked for 15 minutes before it ends; a 401 signs in again once. A 429 is waited out for `Retry-After` seconds, up to a minute, three times, then left to `runSync`, which retries from the checkpoint.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `agreement.updated` | An envelope: `docusign:envelope:<id>`, its kind, status and times, how many must sign, how many have, how many are still to, and its recipients | envelope and a hash of what was read |

Each version is keyed by a hash of what was read, so a change is stored once and a replay is a duplicate. An envelope with no time that reads is dead-lettered.

**Webhooks.** Docusign Connect, in the JSON SIM format with the envelope summary and recipients included. `verifyDocusignConnect` checks the `X-Docusign-Signature-N` headers against the raw body with each of `DOCUSIGN_CONNECT_HMAC_KEYS`, in constant time, before the body is parsed. Docusign signs no timestamp, so a delivery generated more than a day ago, one for another account, or one whose summary doesn't match its envelope gives no events, and the event keys are the sync's own, so a replay stores nothing twice.

**Testing.** The tests run against a mock built from Docusign's developer docs (`packages/testkit/src/mocks/docusign.ts`). Its sign-in checks the JWT's RS256 signature against the app's public key and its claims, including the scope, and answers `consent_required` until the user consents. Its envelope list filters by status change and status, sorts, pages with `start_position`, writes counts as strings and leaves the list out when nothing matches, as Docusign does, and can answer 429. Its assumptions are listed in the mock and checked on the first sandbox run. For the nightly run, make a free Docusign developer account, send a few envelopes of synthetic agreements to test addresses, set up the app and a Viewer user as above, consent once, and add the `SANDBOX_DOCUSIGN_INTEGRATION_KEY`, `SANDBOX_DOCUSIGN_USER_ID`, `SANDBOX_DOCUSIGN_ACCOUNT_ID` and `SANDBOX_DOCUSIGN_PRIVATE_KEY` GitHub Actions secrets.
