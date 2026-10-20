# Security policy

## Reporting a vulnerability

Please report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Don't open a public issue, pull request or discussion for a security problem.

Include what you found, how to reproduce it, and what an attacker could do with it. Leave out real customer data and working credentials; a redacted log line is enough.

We aim to acknowledge a report within three business days and to say what we'll do about it within ten. We'll credit you in the fix's changelog entry unless you'd rather we didn't.

## Supported versions

Only the latest release on `main`, and the container image built from it (`ghcr.io/aasimsayani/karatos-brain:latest`), receive security fixes. Instances should run the latest image.

## Scope

In scope: this repository's code, its container image, its GitHub Actions workflows and the KaratOS website it builds.

Out of scope: a vendor's own API or account security (report those to the vendor), findings that need an already-compromised instance host or API key, and denial of service by volume.

How the system is protected, and what each protection guards against, is in [docs/security.md](docs/security.md).
