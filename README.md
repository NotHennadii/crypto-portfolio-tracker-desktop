# Crypto Portfolio Tracker Desktop (v2)

Windows desktop edition of the product, built with Tauri and running the v1 Next.js app locally.

Goal for v2:
- run fully on user's local machine;
- ship the same feature set as v1 inside a Windows app window;
- evolve further toward local-first secure storage.

## Security Profile (Public Release)

- In-app auto-update installer execution is **disabled**.
- App checks GitHub version metadata only and shows status messages.
- Update installation is **manual only** (download and run installer from official Releases page).
- API credentials are stored only in OS secure storage (`keyring` / Windows Credential Manager).
- Plaintext fallback storage for API keys in browser `localStorage` is removed.

## Stack

- Tauri 2
- Next.js 16 app (ported from v1 web repo)

## Current Status

This repository now includes the v1 application code and launches it via Tauri.

## Prerequisites (Windows)

1. Node.js 20+
2. Rust toolchain (required by Tauri):
   - install from [rustup.rs](https://rustup.rs/)
3. Microsoft Visual Studio C++ Build Tools
4. WebView2 Runtime

Full checklist: [Tauri prerequisites](https://tauri.app/start/prerequisites/).

## Development

```powershell
npm install
npm run tauri dev
```

If PowerShell blocks `npm` scripts, run:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
npm run tauri dev
```

## Build .exe

```powershell
npm run tauri build
```

Generated installer/binaries are placed under `src-tauri/target/release/bundle/`.

## Release Checklist

1. Build installer with `npm run tauri build`.
2. Publish artifacts only to official GitHub Releases.
3. Sign release artifacts (recommended for public distribution).
4. Keep Rust/Node dependencies updated and rerun `npm audit --omit=dev` before each release.
