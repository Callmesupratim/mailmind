// ── Generic IMAP/SMTP provider ────────────────────────────────────────────────
// Works with any mailbox given host/port + app-password (or OAuth accessToken).
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const nodemailer = require("nodemailer");

const PAGE_SIZE = 25;

function makeSmtpTransport(creds) {
  const port   = creds.smtpPort || 465;
  const secure = port === 465;
  if (creds.accessToken) {
    return nodemailer.createTransport({
      host: creds.smtpHost, port, secure,
      auth: { type: 'OAuth2', user: creds.user, accessToken: creds.accessToken },
    });
  }
  return nodemailer.createTransport({
    host: creds.smtpHost, port, secure,
    auth: { user: creds.user, pass: creds.pass },
  });
}

function makeClient(creds) {
  const client = new ImapFlow({
    host: creds.imapHost,
    port: creds.imapPort || 993,
    secure: creds.imapSecure !== false,
    auth: creds.accessToken
      ? { user: creds.user, accessToken: creds.accessToken }
      : { user: creds.user, pass: creds.pass },
    logger: false,
    emitLogs: false,
  });
  // Prevent unhandled 'error' event from crashing the process
  client.on("error", () => {});
  return client;
}

async function withClient(creds, fn) {
  const client = makeClient(creds);
  await client.connect();
  try { return await fn(client); }
  finally { try { await client.logout(); } catch {} }
}

function addrText(a) {
  if (!a || !a.length) return "";
  return a.map(x => x.name ? `${x.name} <${x.address}>` : x.address).join(", ");
}

// ── Resolve special-use folders (Archive/Trash/Spam/Drafts/Sent) ─────────────
// Providers use wildly different names; try RFC 6154 special-use flags first,
// then fall back to common name patterns.
async function resolveFolders(client) {
  const out = {
    inbox: "INBOX", archive: null, trash: null,
    drafts: null,   sent: null,    spam: null, all: null,
  };
  try {
    for (const f of await client.list()) {
      switch (f.specialUse) {
        case "\\Archive": out.archive = f.path; break;
        case "\\Trash":   out.trash   = f.path; break;
        case "\\Drafts":  out.drafts  = f.path; break;
        case "\\Sent":    out.sent    = f.path; break;
        case "\\Junk":    out.spam    = f.path; break;  // RFC 6154
        case "\\All":     out.all     = f.path; break;
      }
      // Name-based fallbacks (lower-cased for comparison)
      const lp = f.path.toLowerCase().replace(/[^a-z ]/g, " ").trim();
      if (!out.sent    && /^(sent|sent items|sent mail)$/.test(lp))         out.sent    = f.path;
      if (!out.drafts  && /^(draft|drafts)$/.test(lp))                      out.drafts  = f.path;
      if (!out.trash   && /^(trash|deleted items|bin|deleted messages)$/.test(lp)) out.trash = f.path;
      if (!out.spam    && /^(spam|junk|junk email|junk mail|bulk mail)$/.test(lp)) out.spam  = f.path;
      if (!out.archive && /^(archive|archived)$/.test(lp))                  out.archive = f.path;
    }
  } catch {}
  // Final fallbacks so we never return null for critical folders
  out.trash  = out.trash  || "Trash";
  out.drafts = out.drafts || "Drafts";
  out.sent   = out.sent   || "Sent";
  out.spam   = out.spam   || "Spam";
  return out;
}

// ── Map a Gmail-style q= to an IMAP mailbox path ─────────────────────────────
function folderFromQuery(q, folders) {
  if (/in:sent/i.test(q))    return folders.sent;
  if (/in:drafts/i.test(q))  return folders.drafts;
  if (/in:trash/i.test(q))   return folders.trash;
  if (/in:spam/i.test(q))    return folders.spam;
  if (/in:archive/i.test(q)) return folders.archive || folders.all || "Archive";
  return folders.inbox || "INBOX";
}

// ── IMAP search criteria from query (folder directives already handled above) ─
function searchFromQuery(q, selfEmail) {
  if (/is:unread/i.test(q))               return { seen: false };
  if (/is:starred/i.test(q))              return { flagged: true };
  if (/cc:me/i.test(q) && selfEmail)      return { cc: selfEmail };
  const from = q.match(/from:(\S+)/i);    if (from) return { from: from[1] };
  const subj = q.match(/subject:(\S+)/i); if (subj) return { subject: subj[1] };
  if (/^in:\S+$/i.test(q.trim()))         return {};   // pure folder query → all
  return { or: [{ subject: q }, { body: q }] };
}

// ── Format attachment size ────────────────────────────────────────────────────
function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

module.exports = {
  // ── Connection test (used by Add Mailbox) ──────────────────────────────────
  async testConnection(creds) {
    return withClient(creds, async (client) => {
      const lock = await client.getMailboxLock("INBOX");
      lock.release();
      if (!creds.accessToken) {
        const t = makeSmtpTransport(creds);
        await t.verify();
      }
      return true;
    });
  },

  // ── List a page of emails in any folder ────────────────────────────────────
  async list(creds, { q = "in:inbox", pageToken } = {}) {
    return withClient(creds, async (client) => {
      const folders = await resolveFolders(client);
      const mailbox = folderFromQuery(q, folders);
      const lock = await client.getMailboxLock(mailbox);
      try {
        const criteria = searchFromQuery(q, creds.user);
        let uids = await client.search(
          Object.keys(criteria).length ? criteria : { all: true }, { uid: true }
        );
        uids = uids.sort((a, b) => a - b);
        const page = parseInt(pageToken) || 0;
        const totalPages = Math.ceil(uids.length / PAGE_SIZE);
        const startFromEnd = page * PAGE_SIZE;
        const slice = uids.slice(
          Math.max(0, uids.length - startFromEnd - PAGE_SIZE),
          uids.length - startFromEnd
        );
        if (!slice.length) return { emails: [], nextPageToken: null };

        const emails = [];
        for await (const msg of client.fetch(
          slice, { envelope: true, flags: true, uid: true, headers: ['x-priority', 'importance', 'x-ms-mail-priority'] }, { uid: true }
        )) {
          const env = msg.envelope || {};

          // Derive importance from standard email headers
          let importance = 'normal';
          try {
            const xpri = (msg.headers?.get('x-priority')?.[0] || '').trim();
            const imp  = (msg.headers?.get('importance')?.[0] || '').trim().toLowerCase();
            const msp  = (msg.headers?.get('x-ms-mail-priority')?.[0] || '').trim().toLowerCase();
            if (/^[12]$/.test(xpri) || imp === 'high' || imp === 'urgent' || msp === 'high') importance = 'high';
            else if (/^[45]$/.test(xpri) || imp === 'low') importance = 'low';
          } catch {}

          emails.push({
            id: String(msg.uid),
            _imapFolder: mailbox,
            sender: addrText(env.from),
            subject: env.subject || "(no subject)",
            date: env.date ? new Date(env.date).toISOString() : "",
            snippet: "",
            cc: addrText(env.cc),
            count: 1,
            unread: !msg.flags.has("\\Seen"),
            starred: msg.flags.has("\\Flagged"),
            importance,
          });
        }
        emails.reverse();   // newest first
        const nextPageToken = page + 1 < totalPages ? String(page + 1) : null;
        return { emails, nextPageToken };
      } finally { lock.release(); }
    });
  },

  // ── Fetch a single message; folder tells us which mailbox to open ──────────
  async getThread(creds, uid, folder = "INBOX") {
    return withClient(creds, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!msg) throw new Error("message not found");
        const p = await simpleParser(msg.source);
        try { await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true }); } catch {}

        // Return attachment metadata (content served via /api/attachments)
        const attachments = (p.attachments || []).map((a, i) => ({
          index: i,
          filename: a.filename || `attachment-${i + 1}`,
          contentType: a.contentType || "application/octet-stream",
          size: a.size || (a.content ? a.content.length : 0),
          sizeStr: fmtSize(a.size || (a.content ? a.content.length : 0)),
        }));

        return {
          threadId: String(uid),
          _imapFolder: folder,
          messages: [{
            id: String(uid),
            from: p.from?.text || "",
            to: p.to?.text || "",
            cc: p.cc?.text || "",
            subject: p.subject || "",
            date: p.date ? p.date.toISOString() : "",
            headerMessageId: p.messageId || "",
            body: (p.text || "").trim(),
            html: (p.html || "").toString().trim(),
            attachments,
          }],
        };
      } finally { lock.release(); }
    });
  },

  // ── Download one attachment (re-fetches message on demand) ─────────────────
  async getAttachment(creds, uid, attIndex, folder = "INBOX") {
    return withClient(creds, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!msg) throw new Error("message not found");
        const p = await simpleParser(msg.source);
        const att = (p.attachments || [])[parseInt(attIndex)];
        if (!att) throw new Error("attachment not found");
        return {
          filename: att.filename || "attachment",
          contentType: att.contentType || "application/octet-stream",
          content: att.content,
        };
      } finally { lock.release(); }
    });
  },

  // ── Flags — accept folder so non-INBOX messages work ──────────────────────
  async setRead(creds, uid, read = true, folder = "INBOX") {
    return withClient(creds, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        if (read) await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
        else      await client.messageFlagsRemove(uid, ["\\Seen"], { uid: true });
        return true;
      } finally { lock.release(); }
    });
  },

  async setStar(creds, uid, star = true, folder = "INBOX") {
    return withClient(creds, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        if (star) await client.messageFlagsAdd(uid, ["\\Flagged"], { uid: true });
        else      await client.messageFlagsRemove(uid, ["\\Flagged"], { uid: true });
        return true;
      } finally { lock.release(); }
    });
  },

  // ── Move to Archive / Trash ────────────────────────────────────────────────
  async archive(creds, uid, folder = "INBOX") {
    return withClient(creds, async (client) => {
      const folders = await resolveFolders(client);
      const dest = folders.archive || folders.all;
      const lock = await client.getMailboxLock(folder);
      try {
        if (dest) await client.messageMove(uid, dest, { uid: true });
        else      await client.messageFlagsAdd(uid, ["\\Deleted"], { uid: true });
        return true;
      } finally { lock.release(); }
    });
  },

  async trash(creds, uid, folder = "INBOX") {
    return withClient(creds, async (client) => {
      const folders = await resolveFolders(client);
      const lock = await client.getMailboxLock(folder);
      try {
        if (folders.trash && folders.trash !== folder)
          await client.messageMove(uid, folders.trash, { uid: true });
        else
          await client.messageFlagsAdd(uid, ["\\Deleted"], { uid: true });
        return true;
      } finally { lock.release(); }
    });
  },

  // ── Mark all messages as read in a folder ─────────────────────────────────
  async markAllRead(creds, folder = 'INBOX') {
    return withClient(creds, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const uids = await client.search({ seen: false }, { uid: true });
        if (uids.length) await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
        return { count: uids.length };
      } finally { lock.release(); }
    });
  },

  // ── Permanently delete everything in Trash ─────────────────────────────────
  async emptyTrash(creds) {
    return withClient(creds, async (client) => {
      const folders = await resolveFolders(client);
      const trashFolder = folders.trash || 'Trash';
      const lock = await client.getMailboxLock(trashFolder);
      try {
        const uids = await client.search({ all: true }, { uid: true });
        if (uids.length) {
          await client.messageFlagsAdd(uids, ['\\Deleted'], { uid: true });
          await client.messageExpunge(uids, { uid: true });
        }
        return { count: uids.length };
      } finally { try { lock.release(); } catch {} }
    });
  },

  // ── Send ──────────────────────────────────────────────────────────────────
  async send(creds, { to, cc, bcc, subject, body, html, inReplyTo, references, attachments }) {
    const authConfig = creds.accessToken
      ? { type: "OAuth2", user: creds.user, accessToken: creds.accessToken }
      : { user: creds.user, pass: creds.pass };
    const transport = nodemailer.createTransport({
      host: creds.smtpHost, port: creds.smtpPort || 465,
      secure: (creds.smtpPort || 465) === 465,
      auth: authConfig,
    });
    const headers = {};
    if (inReplyTo) headers["In-Reply-To"] = inReplyTo;
    if (references) headers["References"]  = references;
    const info = await transport.sendMail({
      from: creds.user, to, cc, bcc, subject,
      ...(html ? { html, text: body || '' } : { text: body || '' }),
      headers,
      attachments: (attachments || []).map(a => ({
        filename: a.filename,
        contentType: a.contentType || "application/octet-stream",
        content: Buffer.from(a.data, "base64"),
      })),
    });
    return info.messageId;
  },

  // ── Save draft ─────────────────────────────────────────────────────────────
  async saveDraft(creds, { to, subject, body, inReplyTo, references }) {
    return withClient(creds, async (client) => {
      const folders = await resolveFolders(client);
      const lines = [
        `From: ${creds.user}`, `To: ${to || ""}`,
        `Subject: ${subject || "(no subject)"}`,
        "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8",
      ];
      if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
      if (references) lines.push(`References: ${references}`);
      const raw = lines.join("\r\n") + "\r\n\r\n" + (body || "");
      await client.append(folders.drafts, raw, ["\\Draft"]);
      return true;
    });
  },
};

// Provider presets for the "Add mailbox" form
module.exports.PRESETS = {
  gmail:   { imapHost: "imap.gmail.com",        imapPort: 993, smtpHost: "smtp.gmail.com",        smtpPort: 465 },
  outlook: { imapHost: "outlook.office365.com", imapPort: 993, smtpHost: "smtp.office365.com",    smtpPort: 587 },
  zoho:    { imapHost: "imap.zoho.com",         imapPort: 993, smtpHost: "smtp.zoho.com",         smtpPort: 465 },
  yahoo:   { imapHost: "imap.mail.yahoo.com",   imapPort: 993, smtpHost: "smtp.mail.yahoo.com",   smtpPort: 465 },
};
