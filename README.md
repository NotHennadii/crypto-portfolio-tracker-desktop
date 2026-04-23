# Crypto Portfolio Tracker Desktop (v2)

Windows desktop edition of the product, built with Tauri + React.

Goal for v2:
- run fully on user's local machine;
- avoid cloud-hosted credential storage;
- move history/signal storage to local persistent database.

## Stack

- Tauri 2
- React + TypeScript + Vite

## Current Status

This repository is initialized as the desktop v2 foundation.
Migration of v1 trading logic/UI into desktop modules is the next phase.

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

## Build .exe

```powershell
npm run tauri build
```

Generated installer/binaries are placed under `src-tauri/target/release/bundle/`.

## v1 -> v2 Migration Plan

1. Port dashboard screens and components from web v1.
2. Replace server API routes with local Tauri commands.
3. Store API keys in OS-level secure storage (no plain localStorage).
4. Store history/signals in local SQLite.
5. Add export/import and update channel for desktop releases.
