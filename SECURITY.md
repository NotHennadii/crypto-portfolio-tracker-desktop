# Security Policy

## Supported Version

Public support targets the latest tagged release in this repository.

## Security Model

- API credentials are stored in OS secure storage via `keyring`.
- Credentials are not persisted in plaintext fallback storage.
- In-app executable auto-update is disabled.
- Runtime update checks are informational only (version metadata from GitHub API).

## Reporting a Vulnerability

If you find a security issue, do not open a public issue with exploit details.

Send a private report with:
- affected version;
- reproduction steps;
- impact assessment;
- proof-of-concept (if available).

Until a private security mailbox is configured, use a private channel with the maintainer and request coordinated disclosure.

## Hardening Recommendations for Public Distribution

- Publish installers only from official GitHub Releases.
- Use code signing for MSI/EXE artifacts.
- Verify dependency advisories before each release (`npm audit --omit=dev` and `cargo audit` where available).
- Keep Tauri permissions minimal and review capability files on each feature addition.
