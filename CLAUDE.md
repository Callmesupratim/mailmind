# Mailmind Project

## Project Overview
Mailmind is a custom email client (web app) built with Node.js/Express (server) and vanilla HTML/JS (frontend). It supports Gmail, Microsoft/Outlook, and IMAP accounts with AI features powered by Groq, OpenAI, Anthropic, Gemini, or Mistral.

## Key Files
- `server/index.js` — Express backend: Gmail/Microsoft/IMAP API, AI endpoints, auth
- `server/imap.js` — IMAP/SMTP logic (Zoho, Yahoo, custom servers)
- `server/msgraph.js` — Microsoft Graph API helpers (Outlook)
- `server/db.js` — SQLite database layer, encryption
- `public/index.html` — Entire frontend: UI, email list, compose, reply, AI panel, settings
- `main.js` — Electron entry point: spawns Express server, opens BrowserWindow
- `package.json` — Dependencies + electron-builder config for Windows installer

## Security
- `.env` contains live secrets — **never commit or share**
- Keys: `GROQ_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`
- `SESSION_SECRET` derives the encryption key for stored IMAP/Microsoft credentials — **never change it**

## Service
- Runs as Windows service via NSSM: `Mailmind`
- Restart (requires admin): `Start-Process powershell -Verb RunAs -ArgumentList '-Command nssm restart Mailmind' -WindowStyle Hidden`
- Logs: `logs/service-out.log`, `logs/service-err.log`
- Always run `node -c server/index.js` and `node -c server/imap.js` before restarting

## Electron Desktop App
- Build installer: `npm run dist` (stop NSSM service first)
- Output: `dist\Mailmind Setup 1.0.0.exe` — NSIS installer
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
