### Microsoft OneDrive and SharePoint files

Reads Microsoft Graph (v1.0) for one document library the store chooses, such as a SharePoint site's Documents: its files and folders, then every change, so a department can see a new statement, invoice, appraisal or design file land without anyone moving it. The connector signs in as its own app with a client secret, so nobody signs in again.

| Setting | What it is |
| --- | --- |
| `MICROSOFT_TENANT_ID` | The directory (tenant) id of the store's Microsoft 365 organization |
| `MICROSOFT_CLIENT_ID` | The application (client) id of the store's KaratOS app registration |
| `MICROSOFT_CLIENT_SECRET` | A client secret of that app, sent only to Microsoft's sign-in |
| `MICROSOFT_ONEDRIVE_DRIVE_ID` | The drive id of the library to read. It starts with `b!` |
| `MICROSOFT_ONEDRIVE_FILE_NAMES` | Optional. `keep` (the default) keeps file and folder names; `drop` keeps only ids, kinds and times |
| `MICROSOFT_GRAPH_CLIENT_STATE` | Optional. The clientState a change notification subscription was made with |

**Connecting.** In the Microsoft Entra admin center, register an app named KaratOS (single tenant), remove `User.Read` from its API permissions, add the Microsoft Graph application permission `Sites.Selected` and grant admin consent. That permission alone reaches nothing: an admin then grants the app the `read` role on the one site that holds the library, in Graph Explorer, with `POST https://graph.microsoft.com/v1.0/sites/{site id}/permissions` and the body `{"roles":["read"],"grantedToIdentities":[{"application":{"id":"<client id>","displayName":"KaratOS"}}]}`. Find the site id with `GET /sites/{host}:/sites/{site}?$select=id` and the library's drive id with `GET /sites/{site id}/drives?$select=id,name`. Add a client secret in Certificates & secrets and save its value straight into the host's secret store.

**Read-only.** The app is meant to hold `Sites.Selected` with the `read` role on one site, so it can't see the rest of the organization or change anything. Each sign-in is a client credentials grant for `https://graph.microsoft.com/.default`, and the client reads the token's `roles` claim: if it lists any permission other than `Sites.Selected`, `Lists.SelectedOperations.Selected`, `Files.SelectedOperations.Selected`, `Files.Read.All` or `Sites.Read.All`, the connector stops and says which. It sends only the sign-in and `GET /drives/{drive}/root/delta`. Graph's paging links are never fetched as given: the client reads the delta token out of each one, checks the link is this drive's delta on `graph.microsoft.com` and nothing else, and builds the next request itself. Saving a report and making a notification subscription are declared behind the write gate, and the test shows they are stopped.

**What it reads.** Each request asks Graph for `id`, `name`, `size`, `file`, `folder`, `package`, `root`, `deleted`, `parentReference` and the created and modified times only, so who made or changed an item, its sharing and its links are never fetched. For each file: its id, name, kind (pdf, spreadsheet, document, presentation, image, design or file) and extension, MIME type, its folder's id, created and modified times, size and QuickXorHash. For each folder: its id, name and folder's id. Delta doesn't return paths, so items are tracked by id, and `MICROSOFT_ONEDRIVE_FILE_NAMES=drop` leaves names out too. The library's root isn't an event.

The historical import reads the drive's delta from the start, which lists every folder and file, keeping every folder and each file changed in the last five years. Its last page's delta token becomes the change feed: each later sync asks only for what changed since, including edits, renames, moves and deletions. The incremental sync keeps its own checkpoint, so its first run lists the library once (what the import stored comes back as duplicates) and reads changes from then on. Each batch's checkpoint keeps Graph's token, so a resumed sync asks again from the page it was on. If Graph answers 410 Gone, the library is listed again (at most three times a sync); a deletion in between can't be seen then. A token lasts an hour and a new one is asked for five minutes before it ends; a 401 signs in again once. A 429 or 503 is waited out for `Retry-After` seconds, up to a minute, three times, then left to `runSync`. A 403 says to grant the app the read role, and a 404 to check the drive id.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `document.file_updated` | A file or folder: `onedrive:item:<id>`, its name, kind, folder and the details above | id and a hash of what was read |
| `document.file_removed` | An item with Graph's `deleted` facet: its reference, name and `reason: removed` | id and the page it was read on |

These are the same events Google Drive and Dropbox give. A file with no modified time that reads is dead-lettered. A folder with no modified time and deletions take the time they were read.

**Notifications.** Graph checks a notification address with a POST carrying `?validationToken=`, which `microsoftWebhookValidation` echoes as plain text. Graph doesn't sign notifications: each one carries the `clientState` its subscription was made with, which `webhookPromptsSync` compares in constant time with `MICROSOFT_GRAPH_CLIENT_STATE`. A notification carries no file data, so a matching one prompts the incremental sync, and a replay only prompts a sync that finds nothing new. Graph lets an app subscribe to a drive only with `Files.Read.All`, which reads every site and OneDrive in the organization, so most stores should leave notifications off and sync on a schedule.

**Not yet.** Reading file contents for the statement and invoice imports, as `dropboxFileSource` does for Dropbox, is the next step. A personal OneDrive (consumer account) isn't covered: its app-only sign-in isn't supported.

**Testing.** The tests run against a mock built from Microsoft's client credentials and Graph `driveItem` reference pages (`packages/testkit/src/mocks/microsoft_onedrive.ts`). Its sign-in checks the tenant, client id, secret and scope and gives a JWT whose `roles` claim lists the app's permissions. Every change goes into a log, so a delta token carries on with exactly what changed after it, each item once in its latest state, deletions included; it can expire tokens with 410, revoke access tokens, answer 403 before the read role is granted and answer 429. Its assumptions are listed in the mock and checked on the first sandbox run. For the nightly run, use a Microsoft 365 test tenant with a KaratOS Test site of synthetic statements and invoices, an app given `Sites.Selected` with the read role on that site, and add the `SANDBOX_MICROSOFT_ONEDRIVE_TENANT_ID`, `SANDBOX_MICROSOFT_ONEDRIVE_CLIENT_ID`, `SANDBOX_MICROSOFT_ONEDRIVE_CLIENT_SECRET` and `SANDBOX_MICROSOFT_ONEDRIVE_DRIVE_ID` GitHub Actions secrets.
