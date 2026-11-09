### Dropbox

Reads Dropbox's API (v2) for one folder the store chooses, and everything below it: its files and folders, then every change, so a department can see a new statement, invoice, appraisal or design file land without anyone moving it. The store approves a KaratOS app once and the connector keeps a refresh token, so nobody signs in again.

| Setting | What it is |
| --- | --- |
| `DROPBOX_APP_KEY` | The app key of the store's KaratOS app in the Dropbox App Console |
| `DROPBOX_APP_SECRET` | The app's secret. It goes with each token refresh and checks webhook signatures |
| `DROPBOX_REFRESH_TOKEN` | The refresh token from the account owner approving the app once with offline access |
| `DROPBOX_FOLDER` | The folder to read, as the Dropbox website shows its path, such as `/Accounting`. Not the whole Dropbox |
| `DROPBOX_FILE_NAMES` | Optional. `keep` (the default) keeps file and folder names; `drop` keeps only ids, kinds and times |

**Connecting.** In the App Console, create a Scoped access app with Full Dropbox access named KaratOS, and in its Permissions tab tick only `files.metadata.read` and `files.content.read` (`account_info.read` is always on). Signed in as the account owner, open `https://www.dropbox.com/oauth2/authorize?client_id=<app key>&response_type=code&token_access_type=offline&scope=files.metadata.read%20files.content.read`, choose Allow, and exchange the code it shows once at `POST https://api.dropboxapi.com/oauth2/token` with `grant_type=authorization_code` and the app key and secret, on the host. Save the answer's `refresh_token` straight into the host's secret store.

**Read-only.** Each token refresh asks Dropbox for `account_info.read` and `files.metadata.read` only (and `files.content.read` for file imports), so the token can't write whatever the app was given, and the client stops if Dropbox reports any other scope. It sends only the token refresh, `POST /2/users/get_current_account`, `POST /2/files/list_folder` and `POST /2/files/list_folder/continue`; Dropbox's RPC calls are POSTs, but these only read. File imports also send `POST /2/files/download`. Saving a report is declared behind the write gate, and the test shows it is stopped.

**What it reads.** For each file: its id, name, kind (pdf, spreadsheet, document, presentation, image, design or file) and extension, its modified times, size, revision and content hash, and whether Dropbox can download it. For each folder: its id and name. Paths aren't kept, since folder names often name customers: each file and its folder get a reference made from a hash of the lowercased path, so a deletion, which Dropbox reports by path only, links to the file that was there. Sharing, links and who made a change are never kept, and `DROPBOX_FILE_NAMES=drop` leaves names out too.

The historical import lists the folder and everything below it, 500 entries a page, keeping every folder and each file changed in the last five years. When the listing ends, its cursor becomes the change feed: each later sync asks only for what changed since, including edits, moves and deletions. The incremental sync keeps its own checkpoint, so its first run lists the folder once (what the import stored comes back as duplicates) and reads changes from then on. Each batch's checkpoint keeps Dropbox's cursor, so a resumed sync asks again from the page it was on. If Dropbox resets a cursor, the folder is listed again (at most three times a sync); a deletion in between can't be seen then. Every call names the account's root namespace in `Dropbox-API-Path-Root`, so in a team space the folder path is the one the website shows. A token lasts four hours and a new one is asked for five minutes before it ends; a 401 refreshes once. A 429 is waited out for `Retry-After` seconds, up to a minute, three times, then left to `runSync`.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `document.file_updated` | A file or folder: `dropbox:file:<id>`, its name, kind, path references and the details above | id and a hash of what was read |
| `document.file_removed` | A deleted or moved-away path: its path reference, name and `reason: removed` | path and the page it was read on |

These are the same events Google Drive gives. A file with no modified time that reads is dead-lettered. Folders and deletions carry no time of their own, so they take the time they were read.

**File imports.** `dropboxFileSource` gives the file imports (bank and refiner statements, supplier invoices and the rest) the files directly in one Dropbox folder, read through a client that also asks for `files.content.read`. It skips subfolders and files Dropbox can't download, won't read a file over 25 MB, and checks each download against Dropbox's content hash. Pointing each import's settings at a Dropbox folder is the next step.

**Webhooks.** Dropbox checks the webhook address with a GET carrying `?challenge=`, which `dropboxWebhookChallenge` echoes as plain text. Each notification's `X-Dropbox-Signature` is the hex HMAC-SHA256 of the raw body keyed with the app secret, checked by `verifyDropboxWebhook` in constant time before the body is parsed. A notification only lists the accounts with changes, so it carries no events: `webhookPromptsSync` says whether it names this account, and the incremental sync reads the change. A replay only prompts a sync that finds nothing new.

**Testing.** The tests run against a mock built from Dropbox's HTTP documentation and OAuth guide (`packages/testkit/src/mocks/dropbox.ts`). Its token refresh checks the app's key, secret and refresh token and gives a token with only the scopes asked for, which must be among the app's own. Every change goes into a log, so a listing cursor carries on with exactly what changed after it, deletions included; it can reset cursors, revoke tokens and answer 429. Its assumptions are listed in the mock and checked on the first sandbox run. For the nightly run, make a free Dropbox Basic account with a `/KaratOS Test` folder of synthetic statements and invoices, a scoped test app as above, approve it once, and add the `SANDBOX_DROPBOX_APP_KEY`, `SANDBOX_DROPBOX_APP_SECRET` and `SANDBOX_DROPBOX_REFRESH_TOKEN` GitHub Actions secrets.
