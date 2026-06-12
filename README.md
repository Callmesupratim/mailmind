# Mailmind — AI Email Assistant

A local Node.js app that connects your real Gmail inbox to Groq AI (LLaMA 3.3 70B).
Summarizes emails, extracts action items, and saves draft replies to Gmail.

---

## Quick Setup (5 steps)

### 1. Install dependencies
```bash
cd mailmind
npm install
```

### 2. Get your Groq API key (free)
- Go to https://console.groq.com/keys
- Create an API key
- Copy it

### 3. Set up Google OAuth credentials
1. Go to https://console.cloud.google.com
2. Create a new project (or use an existing one)
3. Click **"APIs & Services"** → **"Enable APIs"** → search **"Gmail API"** → Enable it
4. Click **"APIs & Services"** → **"Credentials"** → **"+ Create Credentials"** → **"OAuth 2.0 Client ID"**
5. Application type: **Web application**
6. Add Authorized redirect URI: `http://localhost:3000/auth/callback`
7. Click Create → copy the **Client ID** and **Client Secret**
8. Go to **"OAuth consent screen"** → add your Gmail as a test user

### 4. Create your .env file
```bash
cp .env.example .env
```
Then open `.env` and fill in your values:
```
GROQ_API_KEY=gsk_...
GOOGLE_CLIENT_ID=....apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/callback
SESSION_SECRET=any-long-random-string-here
PORT=3000
```

### 5. Run the app
```bash
npm start
```
Open your browser at **http://localhost:3000**

---

## What it does

- **Loads your real Gmail inbox** — inbox, unread, important, or search
- **Reads full email threads** — including all replies in a conversation
- **AI analysis via Groq** — summary, sentiment, action items
- **Draft replies** — Professional, Friendly, Brief, or Formal tone
- **Saves drafts to Gmail** — one click sends the draft to your Gmail Drafts folder

---

## Project structure

```
mailmind/
├── server/
│   └── index.js        ← Express server, Gmail API, Groq API
├── public/
│   └── index.html      ← Frontend UI
├── .env.example        ← Copy to .env and fill in
├── package.json
└── README.md
```

---

## Security notes

- OAuth tokens are stored only in your local session (in memory)
- No emails are stored — they're fetched live each time
- Your API keys stay in your `.env` file, never exposed to the browser
- The app runs entirely on your own machine
