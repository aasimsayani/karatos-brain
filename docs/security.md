# Security model

KaratOS holds a jewelry business's sales, customers, stock, money and documents. One mistake can expose all of it, so security is treated like testing: every protection below has a test that fails if it is removed, and every PR's break-it (mutation) check includes security cases.

## What we protect

| Asset | Where it lives |
| --- | --- |
| A client's business data: events, signals, recommendations, documents | That client's own instance and database |
| Vendor credentials and the instance API key | The host's secret store, or `.env.local` (`chmod 600`) on the owner's machine. Never in git. |
| The code and container image every instance runs | This public repo and `ghcr.io/aasimsayani/karatos-brain` |
| Website inquiries | Issues in a private repository, filed by the website server |

## Public and private boundaries

| Repository | Visibility | Holds | Never holds |
| --- | --- | --- | --- |
| `karatos-brain` (this one) | Public, MIT | Engine, connectors, generic mapping profiles, tests with synthetic data, the website | Secrets, customer data, statements, anything about one client |
| A client's instance repo | Private | That client's settings, mapping profiles, deploy runbook | Secret values (they live in the host's secret store) |
| Commercial runbook | Private | Connection guides, vendor issues, sales and support playbooks | Secrets, customer data |
| Brain Console | Private | The paid console | Secrets, customer data |

Guards: `npm run secrets:scan` runs in CI on every push and fails on anything shaped like a key, token or private key. Fake keys in tests are assembled at runtime so no key-shaped literal is ever committed. Recorded vendor responses pass through `scrubRecording`, which refuses to save secret query parameters or headers.

## Threats and controls

### Someone reaches an instance's API

- Every route except `/healthz` needs `Authorization: Bearer <INSTANCE_API_KEY>`. The key is compared with `timingSafeEqual` over fixed-width zero-padded buffers, then by length, so neither its contents nor its length leak through timing.
- Every request is pinned to the instance's one organization. An event naming another organization is refused, so one client's instance can't write into another's data.
- Request bodies are capped (1 MB by default) and must be JSON.
- Responses carry `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, a `default-src 'none'` content policy that also forbids framing, and HSTS, so business data isn't cached by a proxy or browser, sniffed as another type, or framed.

### A connector or vendor misbehaves

- Every connector is read-only. Write actions are declared but run through a `WriteGate` that refuses them until the client turns writes on for that integration, and every attempt is audited. `assertWritesRefused` in the connector test kit checks this for every connector.
- We never request write scopes from a vendor.
- Webhooks are verified (`timingSafeEqual` on the HMAC) before anything is parsed.
- Incoming events are validated against each department's schema; anything malformed goes to the dead-letter table instead of into the brain.

### A file a client drops in is hostile

- POS and statement folders are read as plain CSV text. Nothing in a file is executed, followed as a path or used as a pattern: hidden files and subfolders are skipped, and only `.csv` (or `.txt` for POS) files are read.
- Mapping profiles are validated with a schema before use, and a profile that can't be parsed stops the sync with a named error.

### Someone attacks the website

- A strict `Content-Security-Policy`: `default-src 'none'`, the page's one inline script and one inline style allowed only by their SHA-256 hashes, fonts, form posts and requests only to the site itself, and no framing. An injected `<script>` would be refused by the browser.
- HSTS, `X-Frame-Options: DENY`, `nosniff`, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin`, and a `Permissions-Policy` that turns off camera, microphone, location, payment and USB.
- Fonts are served by the site itself, so no third party sees visitors.
- The font route serves only file names it loaded at start-up; nothing under `/fonts/` can reach other files.
- The inquiry form refuses posts a browser marks as coming from another site, caps the body, drops honeypot submissions, and limits each address to five an hour. The address is the last `X-Forwarded-For` entry, the one Railway's proxy adds, so a sender can't dodge the limit by inventing addresses. The limiter sweeps stale addresses so it can't be grown without bound.
- Visitor text is fenced before it becomes a GitHub issue, so it can't inject markdown or mention people. The website's GitHub token is fine-grained: Issues read and write on the private inquiry repository only.

### The supply chain is compromised

- Every GitHub Action is pinned to a full commit SHA, with its version in a comment. A tag can be moved to new code; a SHA can't.
- Every workflow starts with a read-only token; jobs that need more ask for exactly that (`packages: write` to publish the image, `issues: write` for the nightly reports, `security-events: write` for CodeQL). Checkouts don't keep the token on disk, no workflow uses `pull_request_target`, and event text (titles, branch names) never goes straight into a shell command.
- Dependabot opens weekly update PRs for npm packages, the pinned actions and both Docker base images, and security updates as soon as an advisory is published.
- CodeQL scans the TypeScript on every PR, on every push to `main` and weekly, with the `security-extended` queries.
- `npm ci` installs with `--ignore-scripts` in the Docker builds, and the runtime images run as the unprivileged `node` user.

## The break-it check

Every PR's mutation check now includes security mutations alongside the functional ones. Typical cases: remove an auth or signature check, loosen a key comparison, drop a security header or a CSP directive, widen an allowlist, trust a client-supplied address, let a write past the `WriteGate`, or log a secret. Each must make a test fail. A surviving security mutation is fixed before the PR is opened.

## Reporting

See [SECURITY.md](../SECURITY.md).
