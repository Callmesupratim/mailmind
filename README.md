# Mailmind — AI-Powered Email Client

A desktop email client built with Electron + Node.js. Supports Gmail, Microsoft/Outlook, and custom IMAP accounts with AI-powered summaries, smart replies, and background email sync.

---

## Features

- **Multiple accounts** — Gmail (OAuth), Microsoft/Outlook (OAuth), IMAP (Zoho, Yahoo, custom)
- **AI assistant** — Summarise emails, generate replies, extract action items
- **Multiple AI providers** — Groq, OpenAI, Anthropic, Gemini, Mistral (bring your own key)
- **Background sync** — Runs in system tray, checks for new email at set intervals
- **Notification tones** — 9 built-in sounds + custom .wav/.mp3 support
- **Auto-updates** — New versions install automatically via GitHub Releases

---

## Installation

Download the latest installer from [Releases](https://github.com/Callmesupratim/mailmind/releases):

```
Mailmind Setup x.x.x.exe
```

Run it, follow the prompts, launch from the desktop shortcut.

---

## First-time setup

### Gmail
1. Open the app → **Add Account → Gmail**
2. A browser window opens — sign in with your Google account
3. Grant permissions → you're in

### Microsoft / Outlook
1. **Add Account → Microsoft**
2. Sign in with your Microsoft / Outlook / Office 365 account
3. Grant permissions → done

### IMAP (Zoho, Yahoo, custom mail server)
1. **Add Account → IMAP**
2. Enter your email, password (or app password), and IMAP/SMTP server details

---

## AI setup

Go to **Settings → AI Features** and choose your provider:

| Provider | Free tier | Get key |
|----------|-----------|---------|
| Groq | Yes — fast LLaMA models | console.groq.com/keys |
| OpenAI | No | platform.openai.com |
| Anthropic | No | console.anthropic.com |
| Gemini | Yes | aistudio.google.com |
| Mistral | No | console.mistral.ai |

Paste your API key in Settings → it's stored encrypted on your machine.

---

## For developers — running from source

### Prerequisites
- Node.js 18+
- A `.env` file (copy from `.env.example`)

### 1. Clone and install
```bash
git clone https://github.com/Callmesupratim/mailmind.git
cd mailmind
npm install
```

### 2. Configure `.env`
```bash
cp .env.example .env
```
Fill in:
```
GOOGLE_CLIENT_ID=....apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
SESSION_SECRET=any-long-random-string-min-32-chars
PORT=3000
```

### 3. Google OAuth setup (for Gmail)
1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. APIs & Services → Enable **Gmail API**
3. Credentials → Create **OAuth 2.0 Client ID** (Web application)
4. Authorised redirect URI: `http://localhost:3000/auth/callback`
5. OAuth consent screen → **Publish App** (so all users can sign in)

### 4. Microsoft OAuth setup (for Outlook)
1. Go to [portal.azure.com](https://portal.azure.com) → App registrations → New registration
2. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**
3. Redirect URI: `http://localhost:3000/auth/microsoft/callback`
4. Add permissions: `Mail.ReadWrite`, `Mail.Send`, `User.Read`, `offline_access`
5. Create a client secret

### 5. Run
```bash
# Web app only (browser at http://localhost:3000)
npm start

# Electron desktop app
npm run electron

# Build Windows installer
npm run dist
```

---

## Project structure

```
mailmind/
├── main.js              ← Electron entry: tray, auto-update, background sync
├── preload.js           ← Electron IPC bridge (contextBridge)
├── server/
│   ├── index.js         ← Express server: Gmail/Microsoft/IMAP API, AI endpoints
│   ├── imap.js          ← IMAP/SMTP logic
│   ├── msgraph.js       ← Microsoft Graph API helpers
│   └── db.js            ← SQLite database, credential encryption
├── public/
│   ├── index.html       ← Full frontend (email list, compose, AI panel, settings)
│   ├── sounds/          ← Built-in notification tones
│   └── loading.html     ← Splash screen
├── .env.example         ← Copy to .env and fill in secrets
└── package.json
```

---

## Releasing updates

```powershell
# 1. Bump version in package.json

# 2. Build
nssm stop Mailmind
npm run dist
nssm start Mailmind

# 3. Commit + tag
git add .
git commit -m "vX.X.X — what changed"
git tag vX.X.X
git push origin master vX.X.X

# 4. Publish release (users auto-update on next launch)
gh release create vX.X.X `
  "dist\Mailmind Setup X.X.X.exe" `
  "dist\Mailmind Setup X.X.X.exe.blockmap" `
  "dist\latest.yml" `
  --title "Mailmind X.X.X" `
  --notes "Release notes here"
```

---

## Security

- OAuth tokens and IMAP passwords are stored **encrypted** in a local SQLite database (`%APPDATA%\Mailmind\data.db`)
- Encryption key is generated per-machine and stored in `%APPDATA%\Mailmind\secret.key`
- API keys (Groq, OpenAI, etc.) are stored encrypted in the same database
- No email content is ever sent to any server except your chosen AI provider for analysis
- `.env` contains OAuth client credentials — never commit it

---

## Built with

- [Electron](https://electronjs.org) — desktop shell
- [Express](https://expressjs.com) — local API server
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — local database
- [googleapis](https://github.com/googleapis/google-api-nodejs-client) — Gmail API
- [imapflow](https://imapflow.com) — IMAP client
- [electron-updater](https://www.electron.build/auto-update) — auto-updates
