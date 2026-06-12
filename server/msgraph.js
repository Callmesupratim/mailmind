// ── Microsoft Graph API client for Outlook/Microsoft 365 ────────────────────
// Uses Graph REST API — works with personal Outlook.com and Microsoft 365.
// Key rules for Graph OData params:
//   • $ must be LITERAL (not %24) — build path strings manually, not URLSearchParams
//   • $orderby and $search cannot be combined in one request
//   • $search requires the header: ConsistencyLevel: eventual
const https = require("https");

const PAGE_SIZE = 100;

// ── Raw HTTP helpers ──────────────────────────────────────────────────────────
function graphRequest(token, method, path, body, extraHeaders) {
  const bodyStr = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "graph.microsoft.com",
      path: "/v1.0" + path,
      method,
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
        ...(bodyStr ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) } : {}),
        ...(extraHeaders || {}),
      },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        if (res.statusCode === 204 || !data.trim()) return resolve({});
        try {
          const json = JSON.parse(data);
          if (json.error) {
            console.error("Graph API error:", json.error.code, json.error.message);
            return reject(new Error(json.error.message || JSON.stringify(json.error)));
          }
          resolve(json);
        } catch (e) { reject(new Error("Graph parse error: " + data.slice(0, 300))); }
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const gGet   = (t, p, h)  => graphRequest(t, "GET",   p, null, h);
const gPost  = (t, p, b)  => graphRequest(t, "POST",  p, b);
const gPatch = (t, p, b)  => graphRequest(t, "PATCH", p, b);

// ── Address formatters ────────────────────────────────────────────────────────
function addrStr(a) {
  if (!a?.emailAddress) return "";
  const { name, address } = a.emailAddress;
  return name ? `${name} <${address}>` : address;
}
function addrsStr(arr) {
  return (arr || []).map(addrStr).filter(Boolean).join(", ");
}

// ── Map a Graph message to the shape our frontend expects ─────────────────────
function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function mapMsg(m) {
  const html = m.body?.contentType === "html" ? (m.body?.content || "") : "";
  const text = m.body?.contentType === "text" ? (m.body?.content || "") : "";
  const attachments = (m.attachments || [])
    .filter(a => a['@odata.type'] === '#microsoft.graph.fileAttachment')
    .map(a => ({
      attachmentId: a.id,
      filename: a.name || 'attachment',
      contentType: a.contentType || 'application/octet-stream',
      size: a.size || 0,
      sizeStr: fmtSize(a.size),
    }));
  return {
    id: m.id,
    from: addrStr(m.from),
    to: addrsStr(m.toRecipients),
    cc: addrsStr(m.ccRecipients),
    subject: m.subject || "(no subject)",
    date: m.receivedDateTime || m.sentDateTime || "",
    headerMessageId: m.internetMessageId || "",
    body: text,
    html,
    attachments,
  };
}

// ── Build Graph path for listing messages ($ MUST be literal, not %24) ────────
function buildListPath(folder, skip, filter, search) {
  const sel = "id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,isRead,flag,categories,importance";
  // Rules:
  //   • $search and $orderby cannot be combined
  //   • $filter and $orderby together cause "restriction too complex" on Exchange — omit orderby when filtering
  // Free-text search uses /me/messages (all folders) — folder-scoped path would miss Sent, Archive etc.
  const base = search
    ? `/me/messages?$top=${PAGE_SIZE}&$skip=${skip}&$select=${sel}`
    : `/me/mailFolders/${folder}/messages?$top=${PAGE_SIZE}&$skip=${skip}&$select=${sel}`;
  let path = base;
  if (search) {
    // $search needs ConsistencyLevel: eventual (passed as header in gGet call)
    path += `&$search="${encodeURIComponent(search)}"`;
  } else if (filter) {
    // No $orderby when $filter is present — Exchange rejects the combination
    path += `&$filter=${encodeURIComponent(filter)}`;
  } else {
    path += `&$orderby=receivedDateTime%20desc`;
  }
  return path;
}

module.exports = {
  // ── List a page of emails ───────────────────────────────────────────────────
  async list(token, selfEmail, { q = "in:inbox", pageToken } = {}) {
    let folder = "inbox", filter = null, search = null;

    // Folder switching (must be done before filter/search detection)
    if      (/in:sent/i.test(q))    folder = "sentitems";
    else if (/in:drafts/i.test(q))  folder = "drafts";
    else if (/in:trash/i.test(q))   folder = "deleteditems";
    else if (/in:archive/i.test(q)) folder = "archive";
    else if (/in:spam/i.test(q))    folder = "junkemail";
    // in:inbox / default → stays "inbox"

    // Filter / search (folder-switching queries don't also need a filter)
    if (/is:unread/i.test(q))
      filter = "isRead eq false";
    else if (/is:starred/i.test(q))
      filter = "flag/flagStatus eq 'flagged'";
    else if (/cc:me/i.test(q) && selfEmail)
      filter = `ccRecipients/any(r:r/emailAddress/address eq '${selfEmail}')`;
    else if (q && !/^in:/i.test(q))
      search = q;   // free-text search (not a folder directive)

    const skip = parseInt(pageToken) || 0;
    const path = buildListPath(folder, skip, filter, search);
    const headers = search ? { "ConsistencyLevel": "eventual" } : undefined;

    console.log("Graph list →", path);
    const data = await gGet(token, path, headers);
    const msgs = data.value || [];
    console.log("Graph list ← got", msgs.length, "messages");

    // Count how many messages share each conversationId (within this page).
    // We do NOT deduplicate — every message gets its own row so CC/reply emails
    // are never hidden.  The count badge shows how many related messages exist.
    const convCount = {};
    msgs.forEach(m => {
      const cid = m.conversationId || m.id;
      convCount[cid] = (convCount[cid] || 0) + 1;
    });

    const emails = msgs.map(m => ({
      id: m.id,                               // unique per message (for the list row)
      conversationId: m.conversationId || m.id, // used when loading the full thread
      subject: m.subject || "(no subject)",
      sender: addrStr(m.from),
      to: addrsStr(m.toRecipients),
      cc: addrsStr(m.ccRecipients),
      date: m.receivedDateTime || "",
      snippet: m.bodyPreview || "",
      count: convCount[m.conversationId || m.id], // thread depth badge
      unread: !m.isRead,
      starred: m.flag?.flagStatus === "flagged",
      importance: m.importance || "normal",
      categories: m.categories || [],
    }));

    const hasMore = !!data["@odata.nextLink"];
    return { emails, nextPageToken: hasMore ? String(skip + PAGE_SIZE) : null };
  },

  // ── Fetch full conversation (all messages sharing a conversationId) ──────────
  async getThread(token, conversationId) {
    // $filter + $orderby together → "InefficientFilter / too complex" on Exchange.
    // Fetch without $orderby and sort by receivedDateTime in JS instead.
    const filter = encodeURIComponent(`conversationId eq '${conversationId}'`);
    const sel    = "id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,internetMessageId,isRead";
    const path   = `/me/messages?$filter=${filter}&$select=${sel}&$top=50&$expand=attachments`;

    const data = await gGet(token, path);
    // Sort oldest-first in JS
    const msgs = (data.value || []).sort((a, b) =>
      new Date(a.receivedDateTime) - new Date(b.receivedDateTime)
    );

    // Mark unread messages as read
    await Promise.all(
      msgs.filter(m => !m.isRead)
          .map(m => gPatch(token, `/me/messages/${m.id}`, { isRead: true }).catch(() => {}))
    );

    return { threadId: conversationId, _type: 'microsoft', messages: msgs.map(mapMsg) };
  },

  // ── Flags ────────────────────────────────────────────────────────────────────
  async setRead(token, conversationId, read = true) {
    const filter = encodeURIComponent(`conversationId eq '${conversationId}'`);
    const data = await gGet(token, `/me/messages?$filter=${filter}&$select=id`);
    await Promise.all((data.value || []).map(m =>
      gPatch(token, `/me/messages/${m.id}`, { isRead: read }).catch(() => {})
    ));
    return true;
  },

  async setStar(token, conversationId, star = true) {
    const filter = encodeURIComponent(`conversationId eq '${conversationId}'`);
    const data = await gGet(token, `/me/messages?$filter=${filter}&$select=id`);
    await Promise.all((data.value || []).map(m =>
      gPatch(token, `/me/messages/${m.id}`, {
        flag: { flagStatus: star ? "flagged" : "notFlagged" }
      }).catch(() => {})
    ));
    return true;
  },

  // ── Move to folder ────────────────────────────────────────────────────────────
  async archive(token, conversationId) {
    const filter = encodeURIComponent(`conversationId eq '${conversationId}'`);
    const data = await gGet(token, `/me/messages?$filter=${filter}&$select=id`);
    await Promise.all((data.value || []).map(m =>
      gPost(token, `/me/messages/${m.id}/move`, { destinationId: "archive" }).catch(() => {})
    ));
    return true;
  },

  async trash(token, conversationId) {
    const filter = encodeURIComponent(`conversationId eq '${conversationId}'`);
    const data = await gGet(token, `/me/messages?$filter=${filter}&$select=id`);
    await Promise.all((data.value || []).map(m =>
      gPost(token, `/me/messages/${m.id}/move`, { destinationId: "deleteditems" }).catch(() => {})
    ));
    return true;
  },

  // ── Send ──────────────────────────────────────────────────────────────────────
  async send(token, { to, cc, bcc, subject, body, html, inReplyTo, attachments }) {
    const toRecips  = (to  || '').split(',').map(a => ({ emailAddress: { address: a.trim() } })).filter(r => r.emailAddress.address);
    const ccRecips  = (cc  || '').split(',').map(a => ({ emailAddress: { address: a.trim() } })).filter(r => r.emailAddress.address);
    const bccRecips = (bcc || '').split(',').map(a => ({ emailAddress: { address: a.trim() } })).filter(r => r.emailAddress.address);

    // Map base64 attachments to Graph fileAttachment format
    const graphAttachments = (attachments || []).map(a => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: a.filename,
      contentType: a.contentType || "application/octet-stream",
      contentBytes: a.data,          // already base64
    }));

    const msgBody  = { contentType: html ? "HTML" : "Text", content: html || body || "" };
    const msgShape = {
      subject: subject || "(no subject)",
      body: msgBody,
      toRecipients: toRecips,
      ...(ccRecips.length  ? { ccRecipients:  ccRecips  } : {}),
      ...(bccRecips.length ? { bccRecipients: bccRecips } : {}),
      ...(graphAttachments.length ? { attachments: graphAttachments } : {}),
    };

    // If replying, find the original message by its Internet Message-ID and use
    // Graph's /reply endpoint — this keeps the conversation thread intact.
    if (inReplyTo) {
      try {
        const filter = encodeURIComponent(`internetMessageId eq '${inReplyTo}'`);
        const search = await gGet(token, `/me/messages?$filter=${filter}&$select=id&$top=1`);
        const orig = search.value?.[0];
        if (orig) {
          await gPost(token, `/me/messages/${orig.id}/reply`, { message: msgShape });
          return;
        }
      } catch (e) { console.error("Graph reply-by-id failed:", e.message); }
    }
    // Fall back to sendMail
    await gPost(token, "/me/sendMail", { message: msgShape, saveToSentItems: true });
  },

  // ── Mark all as read in a Graph mail folder ───────────────────────────────────
  async markAllRead(token, folder = 'inbox') {
    let skip = 0, total = 0;
    while (true) {
      const filter = encodeURIComponent('isRead eq false');
      const path = `/me/mailFolders/${folder}/messages?$filter=${filter}&$select=id&$top=50&$skip=${skip}`;
      const data = await gGet(token, path);
      const msgs = data.value || [];
      if (!msgs.length) break;
      await Promise.all(msgs.map(m => gPatch(token, `/me/messages/${m.id}`, { isRead: true }).catch(() => {})));
      total += msgs.length;
      if (!data['@odata.nextLink']) break;
      skip += 50;
    }
    return { count: total };
  },

  // ── Permanently delete all messages in Deleted Items ─────────────────────────
  async emptyTrash(token) {
    let skip = 0, total = 0;
    while (true) {
      const path = `/me/mailFolders/deleteditems/messages?$select=id&$top=50&$skip=${skip}`;
      const data = await gGet(token, path);
      const msgs = data.value || [];
      if (!msgs.length) break;
      await Promise.all(msgs.map(m =>
        graphRequest(token, 'DELETE', `/me/messages/${m.id}`, null).catch(() => {})
      ));
      total += msgs.length;
      if (!data['@odata.nextLink']) break;
      skip += 50;
    }
    return { count: total };
  },

  // ── Save draft ─────────────────────────────────────────────────────────────
  async saveDraft(token, { to, subject, body }) {
    const draft = await gPost(token, "/me/messages", {
      subject: subject || "(no subject)",
      body: html ? { contentType: "HTML", content: html } : { contentType: "Text", content: body || "" },
      toRecipients: to ? [{ emailAddress: { address: to } }] : [],
      isDraft: true,
    });
    return draft.id;
  },
};
