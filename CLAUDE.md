# Mailmind Project

## Project Overview
Mailmind is a custom email client (Electron desktop app + web app) built with Node.js/Express (server) and vanilla HTML/JS (frontend). It supports Gmail, Microsoft/Outlook, and IMAP accounts with AI features powered by Groq, OpenAI, Anthropic, Gemini, or Mistral.

## Frontend Features (all in public/index.html, state in localStorage)
- Multiple signatures: `mm-signatures` (JSON array `{id,name,html,isDefault}`); legacy single `mm-signature` auto-migrates. Switcher dropdowns in compose (`cm-sig-select`) and reply (`rb-sig-select`).
- Per-mailbox accent themes: `mm-acct-accents` (JSON map acctId→themeId). Accent hue is a single CSS var `--accent-h` set on `<html>`; all accent colours derive from it via `oklch(... var(--accent-h,136))`. Picker opens from colour dot on sidebar account hover.
- Dark/light theme: `mm-theme` via `data-theme` attribute.

## Key Files
- `server/index.js` — Express backend: Gmail/Microsoft/IMAP API, AI endpoints, auth
- `server/imap.js` — IMAP/SMTP logic (Zoho, Yahoo, custom servers)
- `server/msgraph.js` — Microsoft Graph API helpers (Outlook)
- `server/db.js` — SQLite database layer, encryption
- `public/index.html` — Entire frontend: UI, email list, compose, reply, AI panel, settings
- `main.js` — Electron entry point: spawns Express server, opens BrowserWindow
- `package.json` — Dependencies + electron-builder config for Windows installer

## Security
- `.env` contains live secrets — **never commit or share**. Used by the NSSM **web** deployment (full secret set).
- Keys: `GROQ_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`
- `SESSION_SECRET` derives the encryption key for stored IMAP/Microsoft credentials — **never change it**
- **Installer bundles `.env.dist`, NOT `.env`** (the desktop app is distributed publicly). `.env.dist` holds **only OAuth creds** — no AI keys (users supply their own via Settings → AI Features; resolved request → DB → env in `server/index.js` `resolveKey`), no `SESSION_SECRET` (the desktop app injects a per-machine secret in `main.js`). `.env.dist` is gitignored.
- **Regenerate `.env.dist` whenever you rotate OAuth creds in `.env`** — filter the live `.env` to the OAuth allowlist (`GOOGLE_*`, `MICROSOFT_*`, `ZOHO_*`, `YAHOO_*`; exclude AI keys, `SESSION_SECRET`, `MAILMIND_SECRET`, `PORT`). package.json `build.extraResources` maps `.env.dist` → `.env` inside the app.

## Service
- Runs as Windows service via NSSM: `Mailmind`
- Restart (requires admin): `Start-Process powershell -Verb RunAs -ArgumentList '-Command nssm restart Mailmind' -WindowStyle Hidden`
- Logs: `logs/service-out.log`, `logs/service-err.log`
- Always run `node -c server/index.js` and `node -c server/imap.js` before restarting

## Electron Desktop App
- Build installer: `npm run dist` (stop NSSM service first; run from project dir)
- Output: `dist\Mailmind-Setup-X.X.X.exe` — NSIS installer (hyphenated `artifactName`, required for GitHub auto-update URLs)
- Single-instance lock: if the installed Mailmind is running (tray), `npm run electron` exits immediately — quit the installed app first to test dev changes
- Auto-update: electron-updater + GitHub Releases (repo Callmesupratim/mailmind, public)
- Release flow: bump version → `npm run dist` → commit + tag `vX.X.X` → push → `gh release create vX.X.X` with the exe, .blockmap, and latest.yml
- `bin/node.exe` — bundled Node.js 24 binary (87 MB), required for better-sqlite3 ABI match
- `icon.png` — 256×256 app icon (resized from LogoMailmind-removebg-preview.png)

## Ignored Files — Do Not Read or Edit
- `node_modules/` — dependencies, never touch
- `data.db`, `data.db-shm`, `data.db-wal` — SQLite database, never edit directly
- `logs/` — runtime logs, read-only for debugging
- `package-lock.json` — auto-generated
- `dist/` — electron-builder output, never edit directly
- `bin/node.exe` — bundled Node.js binary, never edit
- `LogoMailmind-removebg-preview.png` — original logo asset, never edit
- `icon.png` — generated app icon, never edit
- `patch_categories.js` — one-off migration script, ignore
- `setup-mailmind-service.ps1` — one-off setup script, ignore
- `.env` — secrets, never read or commit
