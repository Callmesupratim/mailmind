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
  CREATE TABLE IF NOT EXISTS sender_seen (
    account_id  INTEGER NOT NULL,
    sender_email TEXT   NOT NULL,
    thread_id   TEXT    NOT NULL,
    received_ts INTEGER,
    PRIMARY KEY (account_id, sender_email, thread_id)
  );
  CREATE TABLE IF NOT EXISTS sender_replies (
    account_id    INTEGER NOT NULL,
    sender_email  TEXT    NOT NULL,
    replied_count INTEGER DEFAULT 0,
    last_replied  INTEGER,
    PRIMARY KEY (account_id, sender_email)
  );
  CREATE TABLE IF NOT EXISTS telemetry (
    install_uuid TEXT PRIMARY KEY,
    app_version  TEXT,
    os_platform  TEXT,
    locale       TEXT,
    country      TEXT,
    first_seen   INTEGER,
    last_seen    INTEGER,
    ping_count   INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS contacts (
    account_id INTEGER NOT NULL,
    email      TEXT    NOT NULL,            -- lowercased bare address
    name       TEXT    NOT NULL DEFAULT '', -- best-known display name ('' = unknown)
    sent_count INTEGER NOT NULL DEFAULT 0,  -- times the user ADDRESSED them (To/CC/BCC)
    seen_count INTEGER NOT NULL DEFAULT 0,  -- distinct received threads they appeared in
    last_used  INTEGER,
    PRIMARY KEY (account_id, email)
  );
  -- Recipient autocomplete searches across ALL accounts, so it can't use the
  -- (account_id, email) primary-key index. This one makes email LIKE 'q%' a range scan.
  CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
  CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at INTEGER);
  -- Contact groups: a named list of addresses that expands in To/CC/BCC.
  -- Members are stored by address (not by contacts row) so a group survives
  -- its people being removed from the learned address book.
  CREATE TABLE IF NOT EXISTS contact_groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS contact_group_members (
    group_id INTEGER NOT NULL,
    email    TEXT    NOT NULL,              -- lowercased bare address
    name     TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (group_id, email)
  );
`);

// saved = the person came from an imported address book (file or Outlook).
// Imported rows live under IMPORTED_ACCOUNT_ID (0, never a real account id),
// so removing a mailbox doesn't take the user's address book with it.
const IMPORTED_ACCOUNT_ID = 0;
if (!db.prepare("PRAGMA table_info(contacts)").all().some(c => c.name === "saved")) {
  db.exec("ALTER TABLE contacts ADD COLUMN saved INTEGER NOT NULL DEFAULT 0");
}

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

// ── One-time backfill: seed `contacts` from the pre-existing sender tables ─────
// sender_seen / sender_replies already hold up to 90 days of real addresses, so
// seeding makes recipient autocomplete useful on first run instead of starting
// empty. Those tables store no display names, so `name` stays '' until live
// ingestion fills it in.
// Runs BEFORE the 90-day sender_seen prune below, so the first run sees the
// maximum available history. Idempotency comes from the `migrations` marker row
// (not from row state), so it survives someone emptying `contacts`.
const MIG_CONTACTS = "contacts_backfill_v1";
if (!db.prepare("SELECT 1 FROM migrations WHERE name = ?").get(MIG_CONTACTS)) {
  const tx = db.transaction(() => {
    // LIKE '%_@_%' uses `_` as the SINGLE-CHAR wildcard on purpose — it means
    // "contains an @ with at least one character either side". Not a typo.
    // MAX(a, b) with two args is SQLite's scalar max, not the aggregate — correct here.
    db.prepare(`
      INSERT INTO contacts (account_id, email, name, sent_count, seen_count, last_used)
      SELECT account_id, LOWER(sender_email), '', 0, COUNT(*), MAX(COALESCE(received_ts, 0))
      FROM sender_seen WHERE sender_email LIKE '%_@_%'
      GROUP BY account_id, LOWER(sender_email)
      ON CONFLICT(account_id, email) DO UPDATE SET
        seen_count = MAX(seen_count, excluded.seen_count),
        last_used  = MAX(COALESCE(last_used, 0), excluded.last_used)
    `).run();
    db.prepare(`
      INSERT INTO contacts (account_id, email, name, sent_count, seen_count, last_used)
      SELECT account_id, LOWER(sender_email), '', replied_count, 0, COALESCE(last_replied, 0)
      FROM sender_replies WHERE sender_email LIKE '%_@_%'
      ON CONFLICT(account_id, email) DO UPDATE SET
        sent_count = MAX(sent_count, excluded.sent_count),
        last_used  = MAX(COALESCE(last_used, 0), excluded.last_used)
    `).run();
    // Never suggest the user back to themselves
    db.prepare(`DELETE FROM contacts WHERE email IN
      (SELECT LOWER(email) FROM accounts WHERE email IS NOT NULL AND email <> '')`).run();
    db.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)").run(MIG_CONTACTS, Date.now());
  });
  try { tx(); } catch (e) { console.error("contacts backfill failed:", e.message); }
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

// ── Sender relationship statements (for priority scoring) ─────────────────────
const stmtSenderSeenInsert = db.prepare(`
  INSERT OR IGNORE INTO sender_seen (account_id, sender_email, thread_id, received_ts) VALUES (?, ?, ?, ?)
`);
const stmtSenderSeenStats = db.prepare(`
  SELECT COUNT(*) received_count, MAX(received_ts) last_received
  FROM sender_seen WHERE account_id = ? AND sender_email = ?
`);
const stmtSenderReplyUpsert = db.prepare(`
  INSERT INTO sender_replies (account_id, sender_email, replied_count, last_replied)
  VALUES (?, ?, 1, ?)
  ON CONFLICT(account_id, sender_email) DO UPDATE SET
    replied_count = replied_count + 1, last_replied = excluded.last_replied
`);
const stmtSenderReplyGet = db.prepare(`
  SELECT replied_count, last_replied FROM sender_replies WHERE account_id = ? AND sender_email = ?
`);
// ── Contacts statements (recipient autocomplete) ──────────────────────────────
const stmtContactBump = db.prepare(`
  INSERT INTO contacts (account_id, email, name, sent_count, seen_count, last_used)
  VALUES (@accountId, @email, @name, @sent, @seen, @ts)
  ON CONFLICT(account_id, email) DO UPDATE SET
    sent_count = sent_count + @sent,
    seen_count = seen_count + @seen,
    name       = CASE WHEN @name <> '' THEN @name ELSE name END,
    last_used  = MAX(COALESCE(last_used, 0), @ts)
`);

// Ranked prefix search, aggregated across every connected account — one person,
// one address book. MAX(name) over TEXT prefers any real name to '' (the empty
// string sorts below everything), so a name learned on one mailbox surfaces on all.
//
// Ranking is three STRICT keys, not a weighted blend: "I have emailed this person"
// is categorically stronger than "mail arrived from them", so someone emailed once
// must outrank a newsletter received 400 times. A blended score (sent*10 + seen)
// needs a magic constant and inverts at scale. Recency breaks ties in the long tail.
//
// The name match is a subquery on `email`, NOT a plain `OR name LIKE @pre`, because
// WHERE filters ROWS before GROUP BY: if a contact's name is known on one account
// but blank on another, the plain form drops the blank-named row and silently loses
// its sent/seen counts from the SUM. Selecting the whole group by email fixes that,
// and keeps the idx_contacts_email range scan for the common email-prefix case.
//
// A saved (imported) contact ranks between "emailed" and "only heard from": it's
// someone the user chose to keep, which beats a newsletter, but not someone they
// actually write to. Its name wins over a learned one — the address book entry is
// what the user typed, a From header is whatever the sender's client put there.
const stmtContactSearch = db.prepare(`
  SELECT email,
         COALESCE(MAX(CASE WHEN saved = 1 AND name <> '' THEN name END), MAX(name)) AS name,
         SUM(sent_count) AS sent_count,
         SUM(seen_count) AS seen_count,
         MAX(last_used)  AS last_used
  FROM contacts
  WHERE email LIKE @pre ESCAPE '\\'
     OR email LIKE @dom ESCAPE '\\'
     OR email IN (SELECT email FROM contacts
                  WHERE name LIKE @pre ESCAPE '\\' OR name LIKE @word ESCAPE '\\')
  GROUP BY email
  ORDER BY SUM(sent_count) DESC,
           MAX(saved)      DESC,
           SUM(seen_count) DESC,
           MAX(last_used)  DESC,
           email ASC
  LIMIT @limit
`);

const stmtContactImport = db.prepare(`
  INSERT INTO contacts (account_id, email, name, sent_count, seen_count, last_used, saved)
  VALUES (${IMPORTED_ACCOUNT_ID}, @email, @name, 0, 0, NULL, 1)
  ON CONFLICT(account_id, email) DO UPDATE SET
    name  = CASE WHEN @name <> '' THEN @name ELSE name END,
    saved = 1
`);
const stmtContactImportedHas = db.prepare(`SELECT 1 FROM contacts WHERE account_id = ${IMPORTED_ACCOUNT_ID} AND email = ?`);
const stmtContactCounts = db.prepare(`
  SELECT (SELECT COUNT(DISTINCT email) FROM contacts)             AS total,
         (SELECT COUNT(*) FROM contacts WHERE saved = 1)          AS saved
`);

// ── Contact group statements ──────────────────────────────────────────────────
const stmtGroupList    = db.prepare("SELECT id, name FROM contact_groups ORDER BY name COLLATE NOCASE");
const stmtGroupGet     = db.prepare("SELECT id, name FROM contact_groups WHERE id = ?");
const stmtGroupByName  = db.prepare("SELECT id FROM contact_groups WHERE name = ?");
const stmtGroupInsert  = db.prepare("INSERT INTO contact_groups (name, created_at, updated_at) VALUES (?, ?, ?)");
const stmtGroupRename  = db.prepare("UPDATE contact_groups SET name = ?, updated_at = ? WHERE id = ?");
const stmtGroupDelete  = db.prepare("DELETE FROM contact_groups WHERE id = ?");
const stmtMembersList  = db.prepare("SELECT email, name FROM contact_group_members WHERE group_id = ? ORDER BY CASE WHEN name = '' THEN email ELSE name END COLLATE NOCASE");
const stmtMembersClear = db.prepare("DELETE FROM contact_group_members WHERE group_id = ?");
const stmtMemberAdd    = db.prepare("INSERT OR REPLACE INTO contact_group_members (group_id, email, name) VALUES (?, ?, ?)");
// Same matching rules as people: name prefix, or the start of a later word.
const stmtGroupSearch  = db.prepare(`
  SELECT id, name FROM contact_groups
  WHERE name LIKE @pre ESCAPE '\\' OR name LIKE @word ESCAPE '\\'
  ORDER BY name COLLATE NOCASE LIMIT 5
`);

// Bare, lowercased address or null — the one shape every contacts table stores.
function cleanEmail(e) {
  const v = String(e || "").trim().toLowerCase();
  return /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(v) && v.length <= 254 ? v : null;
}
function cleanName(n) { return String(n || "").replace(/\s+/g, " ").trim().slice(0, 120); }

// Prune sender_seen rows older than 90 days so the table doesn't grow unbounded
db.prepare("DELETE FROM sender_seen WHERE received_ts < ?").run(Date.now() - 90 * 24 * 60 * 60 * 1000);

// ── Telemetry statements ───────────────────────────────────────────────────────
const stmtTelemetryGet    = db.prepare("SELECT last_seen FROM telemetry WHERE install_uuid = ?");
const stmtTelemetryUpsert = db.prepare(`
  INSERT INTO telemetry (install_uuid, app_version, os_platform, locale, country, first_seen, last_seen, ping_count)
  VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT(install_uuid) DO UPDATE SET
    app_version = excluded.app_version, locale = excluded.locale,
    country = excluded.country, last_seen = excluded.last_seen,
    ping_count = ping_count + 1
`);

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

  // ── Sender relationship (for priority scoring) ────────────────────────────────
  // Idempotent per (account, sender, thread) — safe to call on every list poll
  // without inflating the count when the same thread is re-fetched.
  // Returns true only when a row was ACTUALLY inserted (i.e. the first time this
  // thread was ever seen). Callers use that to gate once-per-thread side effects —
  // this runs on every list poll, so anything ungated would inflate without bound.
  recordSenderSeen(accountId, senderEmail, threadId, receivedTs) {
    if (!senderEmail || !threadId) return false;
    return stmtSenderSeenInsert.run(accountId, senderEmail, threadId, receivedTs || Date.now()).changes > 0;
  },
  // Call once per actual send — each call is a real user action, so a plain
  // increment (no dedup) is correct here.
  recordSenderReply(accountId, senderEmail) {
    if (!senderEmail) return;
    stmtSenderReplyUpsert.run(accountId, senderEmail, Date.now());
  },
  getSenderStats(accountId, senderEmail) {
    if (!senderEmail) return { receivedCount: 0, repliedCount: 0, lastReceived: null, lastReplied: null };
    const seen   = stmtSenderSeenStats.get(accountId, senderEmail) || {};
    const replied = stmtSenderReplyGet.get(accountId, senderEmail) || {};
    return {
      receivedCount: seen.received_count || 0,
      repliedCount:  replied.replied_count || 0,
      lastReceived:  seen.last_received || null,
      lastReplied:   replied.last_replied || null,
    };
  },

  // ── Contacts (recipient autocomplete) ────────────────────────────────────────
  // sent = the user addressed them (strong signal); seen = they appeared in
  // received mail (weak, tie-break only). Callers pass 1/0 for whichever applies.
  recordContact(accountId, email, name, sent, seen, ts) {
    if (!email) return;
    stmtContactBump.run({
      accountId,
      email: String(email).toLowerCase(),
      name: (name || "").slice(0, 120),
      sent: sent | 0,
      seen: seen | 0,
      ts: ts || Date.now(),
    });
  },
  searchContacts(q, limit = 8) {
    const raw = String(q || "").trim().toLowerCase();
    if (raw.length < 2) return [];
    // Escape LIKE metacharacters so a query of "%" doesn't match the entire table.
    const e = raw.replace(/[\\%_]/g, (c) => "\\" + c);
    return stmtContactSearch.all({
      pre:  e + "%",
      word: "% " + e + "%",   // match on a later word of the display name (surname)
      dom:  "%@" + e + "%",   // match on the DOMAIN, so "phoenixtek" finds everyone there.
                              // Anchored to "@" rather than a blanket "%q%" so it stays
                              // predictable and doesn't surface junk mid-address matches.
      limit: Math.min(Math.max(limit | 0, 1), 25),
    }).map(r => ({
      email: r.email,
      name:  r.name || "",
      sent:  r.sent_count,
      seen:  r.seen_count,
      last:  r.last_used,
    }));
  },

  // Save address-book entries. Returns { added, updated, skipped }.
  importContacts(list) {
    const out = { added: 0, updated: 0, skipped: 0 };
    const seen = new Set();
    db.transaction(() => {
      for (const c of list || []) {
        const email = cleanEmail(c && c.email);
        if (!email || seen.has(email)) { out.skipped++; continue; }
        seen.add(email);
        if (stmtContactImportedHas.get(email)) out.updated++; else out.added++;
        stmtContactImport.run({ email, name: cleanName(c.name) });
      }
    })();
    return out;
  },
  contactCounts() { return stmtContactCounts.get(); },

  // ── Contact groups ───────────────────────────────────────────────────────────
  listGroups() {
    return stmtGroupList.all().map(g => ({ ...g, members: stmtMembersList.all(g.id) }));
  },
  getGroup(id) {
    const g = stmtGroupGet.get(id);
    return g ? { ...g, members: stmtMembersList.all(g.id) } : null;
  },
  // Create (id null) or replace a group's name and full member list.
  // Throws { code: "duplicate" } when another group already has the name.
  saveGroup(id, name, members) {
    const nm = cleanName(name);
    if (!nm) throw Object.assign(new Error("Group name is required"), { code: "invalid" });
    const clash = stmtGroupByName.get(nm);
    if (clash && clash.id !== id) throw Object.assign(new Error(`A group called "${nm}" already exists`), { code: "duplicate" });
    const now = Date.now();
    let gid = id;
    db.transaction(() => {
      if (gid == null) gid = Number(stmtGroupInsert.run(nm, now, now).lastInsertRowid);
      else if (!stmtGroupGet.get(gid)) throw Object.assign(new Error("Group not found"), { code: "missing" });
      else stmtGroupRename.run(nm, now, gid);
      stmtMembersClear.run(gid);
      const seen = new Set();
      for (const m of members || []) {
        const email = cleanEmail(m && m.email);
        if (!email || seen.has(email)) continue;
        seen.add(email);
        stmtMemberAdd.run(gid, email, cleanName(m.name));
      }
    })();
    return this.getGroup(gid);
  },
  deleteGroup(id) {
    db.transaction(() => { stmtMembersClear.run(id); stmtGroupDelete.run(id); })();
  },
  searchGroups(q) {
    const raw = String(q || "").trim().toLowerCase();
    if (raw.length < 2) return [];
    const e = raw.replace(/[\\%_]/g, (c) => "\\" + c);
    return stmtGroupSearch.all({ pre: e + "%", word: "% " + e + "%" })
      .map(g => ({ ...g, members: stmtMembersList.all(g.id) }))
      .filter(g => g.members.length);
  },

  // ── Telemetry ──────────────────────────────────────────────────────────────────
  // Returns true if the ping was recorded (new or >24 h since last), false if deduped.
  telemetryPing({ install_uuid, app_version, os, locale, country }) {
    const now = Date.now();
    const existing = stmtTelemetryGet.get(install_uuid);
    if (existing && (now - existing.last_seen) < 86400000) return false;
    stmtTelemetryUpsert.run(install_uuid, (app_version||'').slice(0,20),
      (os||'').slice(0,20), (locale||'').slice(0,10), (country||'XX').slice(0,2).toUpperCase(), now, now);
    return true;
  },
  telemetryStats() {
    const now = Date.now(), DAY = 86400000, MONTH = 30 * DAY;
    return {
      total_installs: db.prepare('SELECT COUNT(*) n FROM telemetry').get().n,
      dau:            db.prepare('SELECT COUNT(*) n FROM telemetry WHERE last_seen > ?').get(now - DAY).n,
      mau:            db.prepare('SELECT COUNT(*) n FROM telemetry WHERE last_seen > ?').get(now - MONTH).n,
      by_version:     db.prepare('SELECT app_version v, COUNT(*) n FROM telemetry GROUP BY app_version ORDER BY n DESC').all(),
      by_country:     db.prepare('SELECT country c, COUNT(*) n FROM telemetry GROUP BY country ORDER BY n DESC LIMIT 30').all(),
      by_os:          db.prepare('SELECT os_platform o, COUNT(*) n FROM telemetry GROUP BY os_platform ORDER BY n DESC').all(),
    };
  },
};
