// ── Local persistence (SQLite) ────────────────────────────────────────────────
// Stores connected mail accounts (Gmail OAuth tokens or IMAP/SMTP credentials,
// encrypted at rest) and a cache of AI analysis results.
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");

const db = new Database(process.env.DB_PATH || path.join(__dirname, "..", "data.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    id INTEGER PRIMARY KEY CHECK (id = 1), tokens TEXT NOT NULL, email TEXT, updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS accounts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT    NOT NULL,          -- 'gmail' | 'imap'
    email      TEXT,
    label      TEXT,
    secret     TEXT    NOT NULL,          -- encrypted JSON (OAuth tokens, or IMAP/SMTP creds)
    active     INTEGER DEFAULT 0,
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS ai_cache (
    key TEXT PRIMARY KEY, result TEXT NOT NULL, created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS app_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updated_at INTEGER
  );
`);

// ── Encryption (AES-256-GCM) ───────────────────────────────────────────────────
// Key derived from a secret in .env. Rotating that secret invalidates stored
// credentials (you'd just reconnect the accounts).
// No hardcoded fallback: a predictable key would make a stolen data.db trivially decryptable.
// index.js already fails fast if SESSION_SECRET is unset, so this is always defined in practice.
const SECRET = process.env.MAILMIND_SECRET || process.env.SESSION_SECRET;
if (!SECRET) { console.error("FATAL (db.js): no MAILMIND_SECRET/SESSION_SECRET for encryption key."); process.exit(1); }
const KEY = crypto.scryptSync(SECRET, "mailmind-salt-v1", 32);
function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, data]).toString("base64");
}
function decrypt(str) {
  const buf = Buffer.from(str, "base64");
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), data = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"));
}

// ── One-time migration: move the legacy single Gmail token into accounts ───────
const accountCount = db.prepare("SELECT COUNT(*) n FROM accounts").get().n;
if (accountCount === 0) {
  const legacy = db.prepare("SELECT tokens, email FROM oauth_tokens WHERE id = 1").get();
  if (legacy) {
    try {
      db.prepare(`INSERT INTO accounts (type, email, label, secret, active, created_at)
                  VALUES ('gmail', @email, @label, @secret, 1, @ts)`).run({
        email: legacy.email, label: legacy.email || "Gmail",
        secret: encrypt(JSON.parse(legacy.tokens)), ts: Date.now(),
      });
    } catch (e) { /* legacy row unparseable — ignore */ }
  }
}

// ── Statements ─────────────────────────────────────────────────────────────────
const stmtList     = db.prepare("SELECT id, type, email, label, active FROM accounts ORDER BY created_at ASC");
const stmtGet      = db.prepare("SELECT * FROM accounts WHERE id = ?");
const stmtActive   = db.prepare("SELECT * FROM accounts WHERE active = 1 LIMIT 1");
const stmtFirst    = db.prepare("SELECT * FROM accounts ORDER BY created_at ASC LIMIT 1");
const stmtByEmail  = db.prepare("SELECT * FROM accounts WHERE type = ? AND email = ? LIMIT 1");
const stmtInsert   = db.prepare(`INSERT INTO accounts (type, email, label, secret, active, created_at)
                                 VALUES (@type, @email, @label, @secret, @active, @ts)`);
const stmtSetSecret= db.prepare("UPDATE accounts SET secret = ?, email = COALESCE(?, email) WHERE id = ?");
const stmtClearActive = db.prepare("UPDATE accounts SET active = 0");
const stmtSetActive   = db.prepare("UPDATE accounts SET active = 1 WHERE id = ?");
const stmtDelete   = db.prepare("DELETE FROM accounts WHERE id = ?");
const stmtCacheGet    = db.prepare("SELECT result, created_at FROM ai_cache WHERE key = ?");
const stmtCacheDel    = db.prepare("DELETE FROM ai_cache WHERE key = ?");
const stmtCacheSet    = db.prepare("INSERT OR REPLACE INTO ai_cache (key, result, created_at) VALUES (?, ?, ?)");
const CACHE_TTL_MS    = 7 * 24 * 60 * 60 * 1000; // 7 days
// Prune stale entries on startup
db.prepare("DELETE FROM ai_cache WHERE created_at < ?").run(Date.now() - CACHE_TTL_MS);
const stmtSettingsGet = db.prepare("SELECT data FROM app_settings WHERE id = 1");
const stmtSettingsSet = db.prepare("INSERT OR REPLACE INTO app_settings (id, data, updated_at) VALUES (1, ?, ?)");

function rowToAccount(row, withSecret = false) {
  if (!row) return null;
  const acc = { id: row.id, type: row.type, email: row.email, label: row.label, active: !!row.active };
  if (withSecret) { try { acc.secret = decrypt(row.secret); } catch { acc.secret = null; } }
  return acc;
}

module.exports = {
  // List accounts (no secrets) for the UI
  listAccounts() { return stmtList.all().map(r => rowToAccount(r)); },

  // Active account WITH decrypted secret (for server-side use)
  getActiveAccount() { return rowToAccount(stmtActive.get() || stmtFirst.get(), true); },
  getAccount(id, withSecret = false) { return rowToAccount(stmtGet.get(id), withSecret); },

  setActive(id) {
    const tx = db.transaction(() => { stmtClearActive.run(); stmtSetActive.run(id); });
    tx(); return this.getAccount(id);
  },

  // Add or update a Gmail account (by email), make it active
  upsertGmail(email, tokens) {
    const existing = email ? stmtByEmail.get("gmail", email) : null;
    if (existing) {
      stmtSetSecret.run(encrypt(tokens), email, existing.id);
      this.setActive(existing.id);
      return existing.id;
    }
    const info = stmtInsert.run({ type: "gmail", email, label: email || "Gmail", secret: encrypt(tokens), active: 1, ts: Date.now() });
    this.setActive(info.lastInsertRowid);
    return info.lastInsertRowid;
  },

  // Refresh the encrypted secret for an account (e.g. rotated OAuth token)
  updateSecret(id, obj, email) { stmtSetSecret.run(encrypt(obj), email || null, id); },

  // Add or update a Microsoft (Outlook) OAuth account, make it active
  upsertMicrosoft(email, creds) {
    const existing = email ? stmtByEmail.get("microsoft", email) : null;
    if (existing) {
      stmtSetSecret.run(encrypt(creds), email, existing.id);
      this.setActive(existing.id);
      return existing.id;
    }
    const info = stmtInsert.run({ type: "microsoft", email, label: `Outlook: ${email}`, secret: encrypt(creds), active: 1, ts: Date.now() });
    this.setActive(info.lastInsertRowid);
    return info.lastInsertRowid;
  },

  // Add an IMAP account, make it active
  addImap(email, label, creds) {
    const info = stmtInsert.run({ type: "imap", email, label: label || email, secret: encrypt(creds), active: 1, ts: Date.now() });
    this.setActive(info.lastInsertRowid);
    return info.lastInsertRowid;
  },

  removeAccount(id) {
    const wasActive = stmtGet.get(id)?.active;
    stmtDelete.run(id);
    if (wasActive) { const next = stmtFirst.get(); if (next) stmtSetActive.run(next.id); }
  },

  getCache(key) {
    const r = stmtCacheGet.get(key);
    if (!r) return null;
    if (Date.now() - (r.created_at || 0) > CACHE_TTL_MS) { stmtCacheDel.run(key); return null; }
    try { return JSON.parse(r.result); } catch { return null; }
  },
  setCache(key, result) { stmtCacheSet.run(key, JSON.stringify(result), Date.now()); },
  clearCache() { db.prepare("DELETE FROM ai_cache").run(); },

  // ── AI settings (provider, per-provider model + API keys), encrypted at rest ──
  // Shape: { provider, models: {prov: modelId}, keys: {prov: apiKey} }
  getAISettings() {
    const r = stmtSettingsGet.get();
    if (!r) return { provider: null, models: {}, keys: {} };
    try { const s = decrypt(r.data); return { provider: s.provider || null, models: s.models || {}, keys: s.keys || {} }; }
    catch { return { provider: null, models: {}, keys: {} }; }
  },
  // Merge a partial update into stored settings (so saving one provider's key
  // never wipes another's).
  saveAISettings({ provider, model, apiKey } = {}) {
    const cur = this.getAISettings();
    if (provider) cur.provider = provider;
    const targetProv = provider || cur.provider;
    if (targetProv && model)  cur.models[targetProv] = model;
    if (targetProv && apiKey) cur.keys[targetProv]   = apiKey;
    stmtSettingsSet.run(encrypt(cur), Date.now());
    return cur;
  },
};
