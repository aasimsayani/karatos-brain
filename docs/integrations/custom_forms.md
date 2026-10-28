### Custom forms

Appointment requests, repair intake and custom order requests, from two kinds of form. Typeform forms are read through Typeform's API. Any other form tool, or the business's own website form, posts each submission to the instance signed with a shared secret (below). Both go through the same mapping profile and become the same event, so the departments read them the same way.

Submissions hold the most personal data Brain A reads: names, emails, phone numbers, descriptions in the customer's own words, and photos. The connector keeps only what the profile maps to a safe field and drops the rest before anything is stored.

| Setting | What it is |
| --- | --- |
| `CUSTOMER_REF_KEY` | Generated. The key for customer references (below). Never rotate it: a new key stops old and new requests from linking up |
| `TYPEFORM_ACCESS_TOKEN` | A Typeform personal access token with only `forms:read` and `responses:read` |
| `TYPEFORM_FORM_IDS` | The forms to read, by id, separated by commas. The id is the end of the form's link: `u6nXL7` in `…typeform.com/to/u6nXL7` |
| `TYPEFORM_API_HOST` | Optional. `api.typeform.com` (the default), `api.eu.typeform.com`, or `api.typeform.eu` for Typeform's newer EU data center |
| `TYPEFORM_WEBHOOK_SECRET` | Optional. The secret set on the forms' Typeform webhooks, once webhooks are turned on |
| `WEBHOOK_SIGNING_SECRET` | Generated for every instance. The key a website form signs its submissions with |
| `FORMS_MAPPING_PROFILE` | Optional. `generic`, or the path to a form mapping profile JSON in the client's private instance repo |

**Read-only.** The Typeform client sends GET requests for two things only, a form's definition and its responses, with parameters it checks itself. Typeform has no way to look up which scopes a token holds, so unlike Xero the connector can't refuse a token with more than read access; create it with only the two read scopes, and the allowlist keeps the connector from writing either way. No writes are declared, so the write gate has nothing to allow.

**What it reads from Typeform.** The historical import reads each form's completed responses submitted in the last five years. Incremental syncs read what was submitted since the previous pass started, less five minutes so a response saved mid-pass is never missed; with no checkpoint the first pass looks back 48 hours. Typeform answers newest first, 1000 per page, and pages back with `before` (the last response's token) between fixed `since` and `until` times, so pages don't shift while new responses arrive. Partial responses aren't read. Submitted responses can't be edited, so there are no changes to follow. Each form's definition is read once per run for its question titles and to check its region: Typeform answers an empty list from the wrong host, so if the form's responses link names another host the sync stops and says which `TYPEFORM_API_HOST` to set.

**Rate limits.** Typeform allows two requests a second per account across its Create and Responses APIs. Requests are spaced half a second apart; a 429 is waited out (Typeform's `Retry-After` if it sends one, at most a minute, three tries), then the sync stops and the next run resumes from its checkpoint.

**Mapping profiles.** A profile names the question for each safe field by its Typeform ref, id or title, or a website form's field name, matched without regard to case, spacing or punctuation. It can give a whole form one kind (`forms`), rules that tell the kind from the kind question's answer or the form's title (`kinds`), and the business's own values for item types, metals, stones, budget ranges, store locations and time slots (`values`), each a regular expression and the value it means. `parseFormProfile` validates a profile and says which field is wrong. Profiles for one client's forms belong in that client's instance repo, never here.

```json
{
  "id": "client_forms",
  "name": "Client forms",
  "forms": { "u6nXL7": "repair_intake" },
  "kinds": [{ "match": "\\bconsult", "kind": "appointment_request" }],
  "fields": { "metal": ["Metal", "metal_choice"], "storeLocation": "Which store?" },
  "values": { "storeLocation": [{ "match": "\\bdowntown", "value": "downtown" }] }
}
```

The generic profile reads these question names, and the values it knows are matched before anything else:

| Field | Questions named | Kept as |
| --- | --- | --- |
| kind | Request type, How can we help, What can we help with, Service, Kind | `appointment_request`, `repair_intake`, `custom_order_request` or `other`, by keyword (repair, resize, clean; custom, design, engagement ring, quote; appointment, book, consult, visit) or the form's title |
| `requestedDate` | Preferred date, Appointment date, Requested date, Date | A real calendar day, `YYYY-MM-DD` |
| `requestedTime` | Preferred time, Appointment time, Requested time, Time | A clock time (`2:30 pm` becomes `14:30`), or a time slot the form offers |
| `itemType` | Item type, Type of jewelry, Piece, Item | `engagement_ring`, `wedding_band`, `ring`, `necklace`, `pendant`, `bracelet`, `earrings`, `watch`, `brooch` |
| `metal` | Metal, Metal type, Preferred metal | `yellow_gold`, `white_gold`, `rose_gold`, `platinum`, `palladium`, `silver`, `titanium`, `undecided` |
| `stone` | Stone, Gemstone, Center stone, Stone type | `diamond`, `lab_diamond`, `moissanite`, `sapphire`, `ruby`, `emerald`, `pearl`, `none` |
| `budgetAmount` or `budgetRange` | Budget, Budget range, Price range | A number answer as a whole amount, or a range the form offers |
| `preferredContact` | Preferred contact method, How should we contact you, Contact method | `email`, `phone`, `text`, `in_person` or `video` |
| `storeLocation` | Store, Location, Preferred store | Only a store the form offers, or one the client's profile names |
| customer reference | Email, Email address; Phone, Phone number, Mobile | Never kept; see below. Typeform email and phone questions are used when no name matches |

**What it keeps and drops.** A typed answer is kept only when it matches one of the profile's values, and a choice only as the label the form itself offers; a choice's "other" text is the customer's own words and is dropped like any other typed text. The preferred contact channel is always one of the five fixed values. Names, email addresses, phone numbers, street addresses, descriptions, link and payment answers, signatures, Typeform hidden fields, scores, variables and browser details are never kept. Uploaded files are counted (`attachmentCount`) so repairs sees a photo came with a request, but their links are never followed or stored. A safe field that was answered but couldn't be kept is named in `unmappedFields`, never with its value, so the owner can see which questions the profile should cover.

**Customer references.** A submission's email address, or else its phone number, becomes `customerRef`: `form_customer:` and an HMAC-SHA256 of the normalized address or number, keyed with the instance's `CUSTOMER_REF_KEY`. The same person's requests link up across forms and over the years, but the detail itself is never stored, nobody holding the events can test a guessed address without the key, and two instances never share references. `contactRefs` lists both references when a submission gave both. A plain hash would not do: email addresses are easy to guess and hash.

**Events.** Each submission becomes one `forms.submission_received` event, keyed by provider, form and response id (`custom_forms:typeform:<form>:<response>` or `custom_forms:webhook:<form>:<id>`), so a Typeform response read by the sync and delivered by webhook is stored once and a replay is a duplicate. A request isn't yet a repair ticket or a custom order, which need a price, a promised date and a description, so it has its own type rather than `repair.received` or `custom_order.created`. A submission without a readable time is dead-lettered, not given one.

**Typeform webhooks.** Set a webhook on each form with `TYPEFORM_WEBHOOK_SECRET` as its secret. `verifyTypeformWebhook` checks `Typeform-Signature`, `sha256=` and the base64 HMAC-SHA256 of the raw body; anything else is refused. Typeform signs no timestamp, so a replayed delivery can't be told from the first, but it carries a response already stored and counts as a duplicate. The connector's `handleWebhook` turns a verified `form_response` delivery for a listed form into the same event the sync makes. The instance doesn't take webhooks yet; the scheduled sync picks every response up.

**Signing submissions from a website form.** Any form tool or website that can sign its POST can send submissions. The signing must happen on the website's server: `WEBHOOK_SIGNING_SECRET` must never be in a web page's own code, where anyone could read it. Send the submission as JSON:

```json
{
  "id": "sub_20261022_0001",
  "form": "repair-intake",
  "title": "Repair intake",
  "submittedAt": "2026-10-22T15:04:05Z",
  "kind": "repair_intake",
  "fields": { "item type": "Ring", "metal": "White gold", "preferred date": "2026-11-03", "email": "customer@example.test" }
}
```

`id` is the website's own id for the submission, unique within the form, and `form` names the form; both are letters, digits, `-` and `_`. `title` and `kind` (one of the four kinds) are optional. Field values are text, numbers, true or false, or lists of text, named as the profile names them. Every value is treated as typed by the customer, so only values matching the profile are kept.

Sign it with two headers:

1. `X-KaratOS-Timestamp`: the current Unix time in seconds.
2. `X-KaratOS-Signature`: `v1=` and the hex HMAC-SHA256, keyed with `WEBHOOK_SIGNING_SECRET`, of the timestamp, a full stop and the exact body bytes sent.

```js
import { createHmac } from "node:crypto";

const body = JSON.stringify(submission);
const timestamp = Math.floor(Date.now() / 1000).toString();
const signature = createHmac("sha256", process.env.WEBHOOK_SIGNING_SECRET).update(`${timestamp}.${body}`).digest("hex");
await fetch(instanceFormsUrl, {
  method: "POST",
  headers: { "content-type": "application/json", "x-karatos-timestamp": timestamp, "x-karatos-signature": `v1=${signature}` },
  body,
});
```

`verifyFormWebhook` checks the signature over the raw body before it is parsed, and refuses a timestamp more than five minutes from the instance's clock either way, so a captured submission can't be replayed later and the timestamp can't be changed without breaking the signature. Keep the server's clock synced. `signFormWebhook` makes the same headers for a sender written in Node, and `formWebhookEvents` turns a verified body into the event.

**Testing.** Until a Typeform test account is set up, the tests run against a mock built from Typeform's docs (`packages/testkit/src/mocks/typeform.ts`), which answers a form's definition and its responses only, pages with `before` newest first, filters by `since` and `until`, refuses a page size over 1000, answers 401 without the token, and names the responses host in the form's links. Its assumptions are listed in the mock and checked on the first sandbox run. Fixtures are synthetic and carry the personal data a real submission would, so the tests can check none of it is kept. For the nightly run, create a free Typeform account, build a test form and fill it in with made-up answers, create a personal token with `forms:read` and `responses:read`, and add `SANDBOX_CUSTOM_FORMS_TYPEFORM_TOKEN` and `SANDBOX_CUSTOM_FORMS_TYPEFORM_FORM_ID` as GitHub Actions secrets.
