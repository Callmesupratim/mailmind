require("dotenv").config();
const express = require("express");
const session = require("express-session");
const { google } = require("googleapis");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const iconv = require("iconv-lite");
const store = require("./db");
const imap = require("./imap");
const graph = require("./msgraph");

// MAILMIND_SECRET is injected by main.js as a per-machine randomly generated value.
// When running as an NSSM service (no main.js), fall back to SESSION_SECRET from .env.
const _secret = process.env.MAILMIND_SECRET || process.env.SESSION_SECRET;
if (!_secret || _secret.length < 16) {
  console.error("FATAL: No valid secret found. Set SESSION_SECRET in .env (≥16 chars).");
  process.exit(1);
}
// Normalise so both env vars are set — db.js reads MAILMIND_SECRET || SESSION_SECRET
process.env.MAILMIND_SECRET = _secret;
process.env.SESSION_SECRET  = _secret;

const app = express();
// 25mb: AI analysis sends full thread HTML, and compose/reply send base64 attachments.
// Default 100kb caused 413 errors (returned as HTML → "Unexpected token '<'" in frontend).
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "../public")));
app.use(
  session({
    secret: _secret,
    resave: false,
    saveUninitialized: false,
    rolling: true,   // slide the expiry on every request — stays logged in while active
    cookie: { secure: false, maxAge: 30 * 24 * 60 * 60 * 1000 },  // 30 days
  })
);

// ── AI Engine v2 ──────────────────────────────────────────────────────────────
const DEFAULT_PROVIDER = "groq";
const DEFAULT_MODEL    = "llama-3.3-70b-versatile";

// Per-provider fallback model — prevents sending e.g. a Groq model name to Gemini.
const PROVIDER_DEFAULT_MODEL = {
  groq:      "llama-3.3-70b-versatile",
  openai:    "gpt-4o-mini",
  anthropic: "claude-3-5-sonnet-20241022",
  gemini:    "gemini-2.5-flash",
  mistral:   "mistral-large-latest",
};
// Resolve a model that is valid for the given provider. If the supplied model is
// empty OR looks like it belongs to a different provider, use the provider default.
function resolveModel(provider, model) {
  const p = (provider || DEFAULT_PROVIDER).toLowerCase();
  const fallback = PROVIDER_DEFAULT_MODEL[p] || DEFAULT_MODEL;
  const m = (model && model.trim()) || "";
  if (!m) return fallback;
  // Detect obvious cross-provider mismatches (e.g. "llama-..." sent to gemini)
  const looksLike = {
    gemini:    /^gemini|^models\//i,
    anthropic: /^claude/i,
    openai:    /^(gpt|o[0-9]|chatgpt)/i,
    groq:      /llama|mixtral|gemma|qwen|deepseek|kimi|moonshot/i,
    mistral:   /mistral|mixtral|ministral|codestral|magistral/i,
  };
  const pat = looksLike[p];
  // If we have a pattern for this provider and the model clearly doesn't match
  // ANY known provider family except a different one, fall back.
  if (pat && !pat.test(m)) {
    // Does it match some OTHER provider's family? If so it's a mismatch → fallback.
    const belongsElsewhere = Object.entries(looksLike)
      .some(([prov, rx]) => prov !== p && rx.test(m));
    if (belongsElsewhere) return fallback;
  }
  return m;
}

// Shared system prompt — Anthropic caches this block; others receive it as system role.
const _SYSTEM_BASE =
`You are Mailmind AI — a senior email intelligence assistant embedded in a professional email client.

Core rules:
• The LAST message in the thread is what requires attention and response
• You are always assisting the RECIPIENT of the thread, not the sender
• Extract only concrete, verifiable information — no speculation
• Action items must be specific tasks the user needs to complete
• Priority score: 85-100 urgent/time-sensitive · 65-84 action required · 40-64 normal · <40 FYI

When drafting replies:
• Write FROM the user (recipient) TO the sender of the last message
• NEVER echo or restate what the sender already said — every sentence must add value
• NEVER open with filler phrases ("Thank you for your email", "Hope this finds you well", "I hope you are doing well")
• Respond to the actual purpose of the message: answer questions, confirm actions, acknowledge updates meaningfully
• Match the requested tone; write a complete, well-structured reply — typically 3–6 sentences for simple messages, multiple paragraphs for complex ones`;

// Used for JSON analysis calls — requires strict JSON output
const SYSTEM_PROMPT = _SYSTEM_BASE + `\n• Output strict JSON only — no markdown fences, no explanations outside JSON`;

// Used for streaming text reply calls — must return plain text, NOT JSON
const STREAM_SYSTEM_PROMPT = _SYSTEM_BASE + `\n• Return ONLY plain email body text — absolutely no JSON, no curly braces, no field names, no markdown, no code blocks`;

// ── Route table (used by analysis, streaming, quick-replies) ──────────────────
const OPENAI_HOSTS = {
  openai:  { hostname: "api.openai.com",   path: "/v1/chat/completions"        },
  mistral: { hostname: "api.mistral.ai",   path: "/v1/chat/completions"        },
  groq:    { hostname: "api.groq.com",     path: "/openai/v1/chat/completions" },
};
function resolveKey(p, supplied) {
  const envMap = { openai: "OPENAI_API_KEY", mistral: "MISTRAL_API_KEY", groq: "GROQ_API_KEY",
                   anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY" };
  // Priority: key supplied with the request → key saved in the DB (Settings) → .env fallback.
  let stored;
  try { stored = store.getAISettings().keys[p]; } catch { stored = null; }
  const key = (supplied && supplied.trim()) || stored || process.env[envMap[p] || "GROQ_API_KEY"];
  if (!key) throw new Error(`${p} API key not set — add it in Settings → AI Features`);
  return key;
}

// Format thread messages as structured named-speaker context for AI
function formatThreadContext(messages) {
  if (!messages || !messages.length) return "(empty thread)";
  const n = messages.length;
  return messages.map((m, i) => {
    const from    = m.from || "Unknown";
    const to      = m.to   ? `To: ${m.to}\n` : "";
    const dateStr = m.date ? new Date(m.date).toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"2-digit", hour:"2-digit", minute:"2-digit" }) : "";
    const subj    = (i === 0 && m.subject) ? `Subject: ${m.subject}\n` : "";
    const body    = ((m.body || "").trim() || htmlToText(m.html || "")).trim().slice(0, 3000);
    const label   = i === n - 1 ? `[MESSAGE ${i+1}/${n} — REPLY TO THIS ONE]` : `[MESSAGE ${i+1}/${n}]`;
    return `${label}\nFrom: ${from}${dateStr ? `  ·  ${dateStr}` : ""}\n${to}${subj}\n${body}`;
  }).join("\n\n" + "─".repeat(60) + "\n\n");
}

// ── JSON analysis call — native JSON mode per provider ────────────────────────
async function callAnalysis(threadContext, { provider, model, apiKey, tone }) {
  const p  = (provider || DEFAULT_PROVIDER).toLowerCase();
  const m  = resolveModel(p, model);
  const t  = tone || "professional";
  const schema = `{
  "summary":   "2-3 sentence overview of the conversation and current state",
  "sentiment": "urgent|requires-action|positive|negative|neutral|fyi",
  "score":     <integer 0-100>,
  "level":     "high|medium|low",
  "tags":      ["tag1","tag2"],
  "actions":   ["specific action the user must take"],
  "entities":  [{"t":"Person|Date|Amount|Topic|Client","v":"value"}],
  "reply":     "complete ready-to-send ${t} reply FROM the user (recipient) TO the sender of the last message — do NOT echo what was said, do NOT open with filler phrases, directly address the purpose of the message, end with a natural sign-off"
}`;
  const userContent = `Analyze this email thread and return ONLY valid JSON matching the schema below.\n\nTHREAD:\n${threadContext}\n\nSCHEMA:\n${schema}`;

  if (p === "anthropic") return _anthropicJson(userContent, { apiKey: resolveKey(p, apiKey), model: m });
  if (p === "gemini")    return _geminiJson(userContent,    { apiKey: resolveKey(p, apiKey), model: m });
  const h = OPENAI_HOSTS[p] || OPENAI_HOSTS.groq;
  return _openAIJson(userContent, { ...h, key: resolveKey(p, apiKey), model: m });
}

// Anthropic: prompt-cached system block + temperature 0.1 for deterministic JSON
function _anthropicJson(userContent, { apiKey, model }) {
  const body = JSON.stringify({
    model, max_tokens: 2048, temperature: 0.1,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userContent }],
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey,
        "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31",
        "Content-Length": Buffer.byteLength(body) },
    }, r => { let d = ""; r.on("data", c => d += c); r.on("end", () => {
      try { const p = JSON.parse(d); if (p.error) return reject(new Error(p.error.message||JSON.stringify(p.error))); resolve(p.content?.[0]?.text || ""); }
      catch(e) { reject(new Error("Anthropic parse: " + d.slice(0,300))); }
    }); });
    req.on("error", reject); req.write(body); req.end();
  });
}

// OpenAI / Groq / Mistral: system message + json_object response_format
// Reasoning models (o1/o3/o4) don't support temperature; o1 also lacks system role + json mode.
function _isReasoning(model) { return /^o\d/i.test(model); }
function _isO1(model)        { return /^o1/i.test(model); }

function _openAIJson(userContent, { hostname, path, key, model }) {
  let bodyObj;
  if (_isReasoning(model)) {
    bodyObj = {
      model, max_completion_tokens: 4096,
      messages: _isO1(model)
        // o1 has no system role — merge prompts into a single user message
        ? [{ role: "user", content: SYSTEM_PROMPT + "\n\n" + userContent }]
        : [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userContent }],
      ...(_isO1(model) ? {} : { response_format: { type: "json_object" } }),
    };
  } else {
    bodyObj = {
      model, temperature: 0.1, max_tokens: 2048,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userContent }],
    };
  }
  const body = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}`, "Content-Length": Buffer.byteLength(body) },
    }, r => { let d = ""; r.on("data", c => d += c); r.on("end", () => {
      try { const p = JSON.parse(d); if (p.error) return reject(new Error(p.error.message||JSON.stringify(p.error))); resolve(p.choices?.[0]?.message?.content || ""); }
      catch(e) { reject(new Error("OpenAI parse: " + d.slice(0,300))); }
    }); });
    req.on("error", reject); req.write(body); req.end();
  });
}

// Gemini: systemInstruction + responseMimeType "application/json"
function _geminiJson(userContent, { apiKey, model }) {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: userContent }] }],
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    generationConfig: {
      responseMimeType: "application/json", temperature: 0.1,
      maxOutputTokens: 4096,        // headroom so the JSON answer isn't truncated
      thinkingConfig: { thinkingBudget: 0 },  // disable 2.5 "thinking" so tokens go to the answer
    },
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "generativelanguage.googleapis.com",
      path: `/v1beta/models/${model}:generateContent?key=${apiKey}`, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, r => { let d = ""; r.on("data", c => d += c); r.on("end", () => {
      try {
        const p = JSON.parse(d);
        if (p.error) return reject(new Error(p.error.message||JSON.stringify(p.error)));
        const text = p.candidates?.[0]?.content?.parts?.[0]?.text || "";
        if (!text) {
          const fr = p.candidates?.[0]?.finishReason;
          console.error("[gemini] empty text; finishReason=" + fr + " raw=" + d.slice(0,400));
          // MAX_TOKENS with thinking models → all budget spent on reasoning, no answer
          if (fr === "MAX_TOKENS") return reject(new Error("Gemini ran out of output tokens (thinking model). Try again."));
        }
        resolve(text);
      }
      catch(e) { reject(new Error("Gemini parse: " + d.slice(0,300))); }
    }); });
    req.on("error", reject); req.write(body); req.end();
  });
}

// ── Streaming reply (SSE) ─────────────────────────────────────────────────────
// Writes  data: {"chunk":"text"}\n\n  …  data: {"done":true}\n\n  to expressRes
async function streamReplyToRes(threadContext, { provider, model, apiKey, tone }, expressRes) {
  const p   = (provider || DEFAULT_PROVIDER).toLowerCase();
  const m   = resolveModel(p, model);
  const t   = tone || "professional";
  const msg = `You are drafting an email reply on behalf of the Mailmind user (the RECIPIENT of this thread).

THREAD (chronological — the LAST message is what you must respond to):
${threadContext}

TASK: Write a ${t} reply from the Mailmind user to the sender of the last message.

REQUIREMENTS:
1. First identify what the last message is communicating: a question, a request, an update, a simple acknowledgment, etc.
2. Respond to that purpose directly — do NOT echo or restate what the sender said
3. Do NOT open with filler ("Thank you for your email", "Hope this finds you well", "I received your message", etc.)
4. If the last message is a pure acknowledgment (e.g. "I have received the item"), respond warmly and move the conversation forward — confirm next steps, express satisfaction, or close the loop naturally
5. If it contains a question, answer it clearly and directly
6. If it requests action, confirm what will be done and by when if known
7. Tone: ${t} — let the tone breathe naturally; do not over-formalise
8. Length: 2–4 sentences for simple messages; expand only when genuine detail is needed
9. End with a natural sign-off matching the tone; do NOT include a name (the user's signature is added separately)

Return ONLY the email body text. No subject line. No meta-commentary. No preamble.`;

  expressRes.setHeader("Content-Type",  "text/event-stream");
  expressRes.setHeader("Cache-Control", "no-cache");
  expressRes.setHeader("Connection",    "keep-alive");
  expressRes.flushHeaders();

  // One-shot guard: provider stop-token AND res 'end' both fire done()/error(),
  // so without this the second expressRes.write() is a write-after-end → can crash Node.
  let finished = false;
  const emit  = t   => { if (!finished) expressRes.write(`data: ${JSON.stringify({ chunk: t })}\n\n`); };
  const done  = ()  => { if (finished) return; finished = true; expressRes.write(`data: ${JSON.stringify({ done: true })}\n\n`); expressRes.end(); };
  const error = e   => { if (finished) return; finished = true; expressRes.write(`data: ${JSON.stringify({ error: e })}\n\n`);  expressRes.end(); };

  try {
    if (p === "anthropic") {
      await _streamAnthropic(msg, { apiKey: resolveKey(p, apiKey), model: m }, emit, done, error);
    } else if (p === "gemini") {
      await _streamGemini(msg,    { apiKey: resolveKey(p, apiKey), model: m }, emit, done, error);
    } else {
      const h = OPENAI_HOSTS[p] || OPENAI_HOSTS.groq;
      await _streamOpenAI(msg, { ...h, key: resolveKey(p, apiKey), model: m }, emit, done, error);
    }
  } catch(e) { error(e.message); }
}

function _streamOpenAI(userContent, { hostname, path, key, model }, onChunk, onDone, onError) {
  // o1 doesn't support streaming — do a regular fetch and emit the full reply as one chunk
  if (_isO1(model)) {
    const body = JSON.stringify({
      model, max_completion_tokens: 1500,
      messages: [{ role: "user", content: STREAM_SYSTEM_PROMPT + "\n\n" + userContent }],
    });
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname, path, method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}`, "Content-Length": Buffer.byteLength(body) },
      }, r => { let d = ""; r.on("data", c => d += c); r.on("end", () => {
        try { const p = JSON.parse(d); if (p.error) { onError(p.error.message||JSON.stringify(p.error)); return resolve(); } onChunk(p.choices?.[0]?.message?.content || ""); onDone(); resolve(); }
        catch(e) { onError("Parse error"); resolve(); }
      }); });
      req.setTimeout(60000, () => { req.destroy(); onError("o1 timed out after 60s"); });
      req.on("error", e => { onError(e.message); reject(e); }); req.write(body); req.end();
    });
  }
  const body = JSON.stringify({
    model, stream: true,
    messages: [{ role: "system", content: STREAM_SYSTEM_PROMPT }, { role: "user", content: userContent }],
    ...(_isReasoning(model)
      ? { max_completion_tokens: 1500 }
      : { temperature: 0.65, max_tokens: 1500 }),
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}`, "Content-Length": Buffer.byteLength(body) },
    }, res => {
      // Surface HTTP errors (rate limit 429, auth 401, etc.) instead of silently succeeding with empty output
      if (res.statusCode >= 400) {
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => {
          try {
            const e = JSON.parse(d);
            const msg = e.error?.message || e.message || `HTTP ${res.statusCode}`;
            onError(res.statusCode === 429 ? `Rate limit — try again in a moment (${msg})` : msg);
          } catch { onError(`HTTP ${res.statusCode}`); }
          resolve();
        });
        return;
      }
      let buf = "", gotChunk = false;
      res.on("data", chunk => {
        buf += chunk.toString();
        const lines = buf.split("\n"); buf = lines.pop();
        for (const line of lines) {
          const tr = line.trim();
          if (!tr.startsWith("data: ")) continue;
          const payload = tr.slice(6);
          if (payload === "[DONE]") { onDone(); return resolve(); }
          try {
            const obj = JSON.parse(payload);
            const text = obj.choices?.[0]?.delta?.content;
            if (text) { gotChunk = true; onChunk(text); }
            if (obj.choices?.[0]?.finish_reason === "stop") { onDone(); resolve(); }
          } catch {}
        }
      });
      res.on("end", () => { onDone(); resolve(); });
      res.on("error", e => { onError(e.message); reject(e); });
    });
    req.setTimeout(30000, () => { req.destroy(); onError("Request timed out after 30s"); });
    req.on("error", e => { onError(e.message); reject(e); });
    req.write(body); req.end();
  });
}

function _streamAnthropic(userContent, { apiKey, model }, onChunk, onDone, onError) {
  const body = JSON.stringify({
    model, max_tokens: 1500, temperature: 0.65, stream: true,
    system: [{ type: "text", text: STREAM_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userContent }],
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey,
        "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31",
        "Content-Length": Buffer.byteLength(body) },
    }, res => {
      if (res.statusCode >= 400) {
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => {
          try {
            const e = JSON.parse(d);
            const msg = e.error?.message || `HTTP ${res.statusCode}`;
            onError(res.statusCode === 429 ? `Rate limit — try again in a moment (${msg})` : msg);
          } catch { onError(`HTTP ${res.statusCode}`); }
          resolve();
        });
        return;
      }
      let buf = "";
      res.on("data", chunk => {
        buf += chunk.toString();
        const lines = buf.split("\n"); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const obj = JSON.parse(line.slice(6));
            if (obj.type === "content_block_delta" && obj.delta?.type === "text_delta") onChunk(obj.delta.text);
            if (obj.type === "message_stop") { onDone(); resolve(); }
          } catch {}
        }
      });
      res.on("end", () => { onDone(); resolve(); });
      res.on("error", e => { onError(e.message); reject(e); });
    });
    req.setTimeout(30000, () => { req.destroy(); onError("Request timed out after 30s"); });
    req.on("error", e => { onError(e.message); reject(e); });
    req.write(body); req.end();
  });
}

function _streamGemini(userContent, { apiKey, model }, onChunk, onDone, onError) {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: userContent }] }],
    systemInstruction: { parts: [{ text: STREAM_SYSTEM_PROMPT }] },
    generationConfig: { temperature: 0.65, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "generativelanguage.googleapis.com",
      path: `/v1beta/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, res => {
      if (res.statusCode >= 400) {
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => {
          try {
            const e = JSON.parse(d);
            const msg = e.error?.message || `HTTP ${res.statusCode}`;
            onError(res.statusCode === 429 ? `Rate limit — try again in a moment (${msg})` : msg);
          } catch { onError(`HTTP ${res.statusCode}`); }
          resolve();
        });
        return;
      }
      let buf = "";
      res.on("data", chunk => {
        buf += chunk.toString();
        const lines = buf.split("\n"); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const obj = JSON.parse(line.slice(6));
            const text = obj.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) onChunk(text);
            if (obj.candidates?.[0]?.finishReason === "STOP") { onDone(); resolve(); }
          } catch {}
        }
      });
      res.on("end", () => { onDone(); resolve(); });
      res.on("error", e => { onError(e.message); reject(e); });
    });
    req.setTimeout(30000, () => { req.destroy(); onError("Request timed out after 30s"); });
    req.on("error", e => { onError(e.message); reject(e); });
    req.write(body); req.end();
  });
}

// ── Quick reply chips ─────────────────────────────────────────────────────────
async function getQuickReplies(threadContext, { provider, model, apiKey }) {
  const p = (provider || DEFAULT_PROVIDER).toLowerCase();
  const m = resolveModel(p, model);
  const userContent = `Based on the most recent email in this thread, suggest exactly 3 brief, natural reply options (4-8 words each). These are quick-action chips.\n\nTHREAD:\n${threadContext.slice(0, 3000)}\n\nReturn ONLY JSON: {"chips":["option 1","option 2","option 3"]}`;
  try {
    let text;
    if (p === "anthropic") {
      const b = JSON.stringify({ model:m, max_tokens:150, temperature:0.5,
        system:[{type:"text",text:"You suggest concise email reply starters.",cache_control:{type:"ephemeral"}}],
        messages:[{role:"user",content:userContent}] });
      text = await new Promise((res,rej) => {
        const req = https.request({ hostname:"api.anthropic.com", path:"/v1/messages", method:"POST",
          headers:{"Content-Type":"application/json","x-api-key":resolveKey(p,apiKey),"anthropic-version":"2023-06-01","anthropic-beta":"prompt-caching-2024-07-31","Content-Length":Buffer.byteLength(b)} },
          r => { let d=""; r.on("data",c=>d+=c); r.on("end",()=>{ try{res(JSON.parse(d).content?.[0]?.text||"")}catch{res("")} }); });
        req.on("error",rej); req.write(b); req.end();
      });
    } else if (p === "gemini") {
      const b = JSON.stringify({ contents:[{parts:[{text:userContent}]}],
        generationConfig:{responseMimeType:"application/json",maxOutputTokens:512,temperature:0.5,thinkingConfig:{thinkingBudget:0}} });
      text = await new Promise((res,rej) => {
        const req = https.request({ hostname:"generativelanguage.googleapis.com",
          path:`/v1beta/models/${m}:generateContent?key=${resolveKey(p,apiKey)}`, method:"POST",
          headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(b)} },
          r => { let d=""; r.on("data",c=>d+=c); r.on("end",()=>{ try{res(JSON.parse(d).candidates?.[0]?.content?.parts?.[0]?.text||"")}catch{res("")} }); });
        req.on("error",rej); req.write(b); req.end();
      });
    } else {
      const h = OPENAI_HOSTS[p] || OPENAI_HOSTS.groq;
      const b = JSON.stringify({ model:m, temperature:0.5, max_tokens:150,
        response_format:{type:"json_object"},
        messages:[{role:"user",content:userContent}] });
      text = await new Promise((res,rej) => {
        const req = https.request({ hostname:h.hostname, path:h.path, method:"POST",
          headers:{"Content-Type":"application/json","Authorization":`Bearer ${resolveKey(p,apiKey)}`,"Content-Length":Buffer.byteLength(b)} },
          r => { let d=""; r.on("data",c=>d+=c); r.on("end",()=>{ try{res(JSON.parse(d).choices?.[0]?.message?.content||"")}catch{res("")} }); });
        req.on("error",rej); req.write(b); req.end();
      });
    }
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text);
    return (parsed.chips || []).filter(Boolean).slice(0, 3);
  } catch(e) {
    console.error("Quick replies:", e.message);
    return ["Sounds good, thanks!", "I'll look into this", "Can we discuss on a call?"];
  }
}

// Legacy shim — kept so any remaining callers don't break
async function callAI(prompt, { provider, model, apiKey } = {}) {
  const p = (provider || DEFAULT_PROVIDER).toLowerCase();
  const m = resolveModel(p, model);
  if (p === "anthropic") return _anthropicJson(prompt, { apiKey: resolveKey(p, apiKey), model: m });
  if (p === "gemini")    return _geminiJson(prompt,    { apiKey: resolveKey(p, apiKey), model: m });
  const h = OPENAI_HOSTS[p] || OPENAI_HOSTS.groq;
  return _openAIJson(prompt, { ...h, key: resolveKey(p, apiKey), model: m });
}

// Plain-text variant — uses STREAM_SYSTEM_PROMPT, no json_object response_format
async function callAIText(prompt, { provider, model, apiKey } = {}) {
  const p = (provider || DEFAULT_PROVIDER).toLowerCase();
  const m = resolveModel(p, model);
  const key = resolveKey(p, apiKey);

  if (p === "anthropic") {
    const body = JSON.stringify({
      model: m, max_tokens: 2048, temperature: 0.7,
      system: [{ type: "text", text: STREAM_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: prompt }],
    });
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key,
          "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31",
          "Content-Length": Buffer.byteLength(body) },
      }, r => { let d = ""; r.on("data", c => d += c); r.on("end", () => {
        try { const parsed = JSON.parse(d); if (parsed.error) return reject(new Error(parsed.error.message)); resolve(parsed.content?.[0]?.text || ""); }
        catch(e) { reject(new Error("Anthropic text parse: " + d.slice(0, 300))); }
      }); });
      req.on("error", reject); req.write(body); req.end();
    });
  }

  if (p === "gemini") {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: STREAM_SYSTEM_PROMPT }] },
      generationConfig: { temperature: 0.7, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
    });
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "generativelanguage.googleapis.com",
        path: `/v1beta/models/${m}:generateContent?key=${key}`, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      }, r => { let d = ""; r.on("data", c => d += c); r.on("end", () => {
        try { const parsed = JSON.parse(d); if (parsed.error) return reject(new Error(parsed.error.message || JSON.stringify(parsed.error))); resolve(parsed.candidates?.[0]?.content?.parts?.[0]?.text || ""); }
        catch(e) { reject(new Error("Gemini text parse: " + d.slice(0, 300))); }
      }); });
      req.on("error", reject); req.write(body); req.end();
    });
  }

  // OpenAI / Groq / Mistral — plain text, no response_format
  const h = OPENAI_HOSTS[p] || OPENAI_HOSTS.groq;
  const bodyObj = {
    model: m, temperature: 0.7, max_tokens: 2048,
    messages: [{ role: "system", content: STREAM_SYSTEM_PROMPT }, { role: "user", content: prompt }],
  };
  const body = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: h.hostname, path: h.path, method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}`, "Content-Length": Buffer.byteLength(body) },
    }, r => { let d = ""; r.on("data", c => d += c); r.on("end", () => {
      try { const parsed = JSON.parse(d); if (parsed.error) return reject(new Error(parsed.error.message || JSON.stringify(parsed.error))); resolve(parsed.choices?.[0]?.message?.content || ""); }
      catch(e) { reject(new Error("OpenAI text parse: " + d.slice(0, 300))); }
    }); });
    req.on("error", reject); req.write(body); req.end();
  });
}

// ── HTML → readable plain text ────────────────────────────────────────────────
function htmlToText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|tr|table|h[1-6]|li)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Build a base64url-encoded RFC 822 message (uses nodemailer MailComposer) ──
// Handles plain text, HTML, and file attachments transparently.
const MailComposer = require("nodemailer/lib/mail-composer");
async function buildGmailRaw({ from, to, cc, bcc, subject, body, html, inReplyTo, references, attachments }) {
  const opts = {
    from: from || "",
    to, cc, bcc,
    subject: subject || "(no subject)",
    ...(html ? { html, text: body || "" } : { text: body || "" }),
    headers: {},
    attachments: (attachments || []).map(a => ({
      filename: a.filename,
      contentType: a.contentType || "application/octet-stream",
      content: Buffer.from(a.data, "base64"),
    })),
  };
  if (inReplyTo) opts.headers["In-Reply-To"] = inReplyTo;
  if (references) opts.headers["References"]  = references;
  return new Promise((resolve, reject) => {
    new MailComposer(opts).compile().build((err, buffer) => {
      if (err) return reject(err);
      resolve(buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
    });
  });
}

// ── Microsoft OAuth (MSAL-lite — raw HTTPS, no extra package needed) ──────────
const MS_TENANT_URL = "https://login.microsoftonline.com/common/oauth2/v2.0";
// Graph-based scopes — no Exchange Online licence required
const MS_SCOPES = [
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/Mail.Send",
  "https://graph.microsoft.com/User.Read",
  "offline_access", "openid", "email", "profile",
].join(" ");

// POST to Microsoft token endpoint (form-encoded)
function msPost(params) {
  const body = Object.entries(params)
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "login.microsoftonline.com",
      path: "/common/oauth2/v2.0/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error_description || json.error));
          resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// GET /v1.0/me from Microsoft Graph to find the user's email
function msGetUserEmail(accessToken) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "graph.microsoft.com",
      path: "/v1.0/me",
      headers: { Authorization: "Bearer " + accessToken },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { const j = JSON.parse(data); resolve(j.mail || j.userPrincipalName || null); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

// Exchange a refresh token for a new access token
async function refreshMicrosoftToken(refreshToken) {
  const data = await msPost({
    grant_type: "refresh_token",
    client_id: process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    refresh_token: refreshToken,
    scope: MS_SCOPES,
  });
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,  // not always returned
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
}

// ── Google OAuth ──────────────────────────────────────────────────────────────
function makeOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "http://localhost:3000/auth/callback"
  );
}

// Attach the active account (Gmail / IMAP / Microsoft).
// For Microsoft accounts: auto-refresh the access token if it expires soon (< 60 s).
// For Gmail: build an authed googleapis client.
// All IMAP and Microsoft routes use req.account.secret (type will read as "imap").
async function withAuth(req, res, next) {
  try {
    // Allow cross-account ops (e.g. All Mail) by passing ?accountId= or body.accountId
    const overrideId = req.query.accountId || req.body?.accountId;
    const acc = overrideId ? store.getAccount(overrideId, true) : store.getActiveAccount();
    if (!acc) return res.status(401).json({ error: "not_authenticated" });
    req.account = acc;

    if (acc.type === "microsoft") {
      // Refresh if expired or expiring within 60 seconds
      if (acc.secret?.refreshToken &&
          (!acc.secret.expiresAt || Date.now() > acc.secret.expiresAt - 60_000)) {
        try {
          const refreshed = await refreshMicrosoftToken(acc.secret.refreshToken);
          const newSecret = { ...acc.secret, ...refreshed };
          store.updateSecret(acc.id, newSecret, acc.email);
          req.account = { ...acc, secret: newSecret };
        } catch (e) {
          console.error("MS token refresh failed:", e.message);
          return res.status(401).json({ error: "microsoft_token_expired",
            message: "Outlook token expired — please reconnect via Add Mailbox → Outlook." });
        }
      }
      // Expose the Graph access token for route handlers
      req.graphToken = req.account.secret?.accessToken;
    } else if (acc.type === "imap" && acc.secret?.provider === 'zoho' && acc.secret?.refreshToken &&
               (!acc.secret.expiresAt || Date.now() > acc.secret.expiresAt - 60_000)) {
      // Auto-refresh Zoho OAuth token
      try {
        const tok = await zohoPost({ grant_type:'refresh_token', client_id:process.env.ZOHO_CLIENT_ID, client_secret:process.env.ZOHO_CLIENT_SECRET, refresh_token:acc.secret.refreshToken });
        const newSecret = { ...acc.secret, accessToken:tok.access_token, expiresAt: Date.now()+(tok.expires_in||3600)*1000 };
        store.updateSecret(acc.id, newSecret, acc.email);
        req.account = { ...acc, secret: newSecret };
      } catch (e) { console.error("Zoho token refresh failed:", e.message); }
    } else if (acc.type === "imap" && acc.secret?.provider === 'yahoo' && acc.secret?.refreshToken &&
               (!acc.secret.expiresAt || Date.now() > acc.secret.expiresAt - 60_000)) {
      // Auto-refresh Yahoo OAuth token
      try {
        const tok = await yahooPost({ grant_type:'refresh_token', refresh_token:acc.secret.refreshToken });
        const newSecret = { ...acc.secret, accessToken:tok.access_token, expiresAt: Date.now()+(tok.expires_in||3600)*1000 };
        store.updateSecret(acc.id, newSecret, acc.email);
        req.account = { ...acc, secret: newSecret };
      } catch (e) { console.error("Yahoo token refresh failed:", e.message); }
    } else if (acc.type === "gmail") {
      if (!acc.secret) return res.status(401).json({ error: "not_authenticated" });
      const oauth2 = makeOAuth2Client();
      oauth2.setCredentials(acc.secret);
      // Persist silently-refreshed access tokens back to the account.
      oauth2.on("tokens", (t) => store.updateSecret(acc.id, { ...acc.secret, ...t }, acc.email));
      req.oauth2 = oauth2;
      req.gmail = google.gmail({ version: "v1", auth: oauth2 });
    }
    next();
  } catch (e) {
    console.error("withAuth error:", e.message);
    res.status(500).json({ error: "auth_error" });
  }
}

// ── Version ───────────────────────────────────────────────────────────────────
const _appVersion = (() => { try { return require('../package.json').version; } catch { return '—'; } })();
app.get("/api/version", (req, res) => res.json({ version: _appVersion }));

// ── Auth routes ───────────────────────────────────────────────────────────────
app.get("/auth/login", (req, res) => {
  const oauth2 = makeOAuth2Client();
  const url = oauth2.generateAuthUrl({
    access_type: "offline", prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.modify",   // read + archive/star/read/trash/labels
      "https://www.googleapis.com/auth/gmail.compose",  // drafts + send
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  });
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect("/?error=" + error);
  if (!code) return res.redirect("/?error=no_code");
  try {
    const oauth2 = makeOAuth2Client();
    const { tokens } = await oauth2.getToken(code);
    let email = null;
    try {
      oauth2.setCredentials(tokens);
      const me = await google.oauth2({ version: "v2", auth: oauth2 }).userinfo.get();
      email = me.data.email;
    } catch {}
    store.upsertGmail(email, tokens);
    res.redirect("/");
  } catch (e) {
    console.error("OAuth callback error:", e.message);
    res.redirect("/?error=oauth_failed");
  }
});

// ── Microsoft OAuth routes ─────────────────────────────────────────────────────
app.get("/auth/microsoft", (req, res) => {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  if (!clientId) return res.status(500).send(
    "MICROSOFT_CLIENT_ID is not set in .env.<br>Please register an Azure app and add the credentials — see the setup guide."
  );
  const redirectUri = process.env.MICROSOFT_REDIRECT_URI || "http://localhost:3000/auth/microsoft/callback";
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: MS_SCOPES,
    response_mode: "query",
    prompt: "select_account",          // always show account picker
  });
  res.redirect(MS_TENANT_URL + "/authorize?" + params.toString());
});

app.get("/auth/microsoft/callback", async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error) return res.redirect("/?error=" + encodeURIComponent(error_description || error));
  if (!code) return res.redirect("/?error=no_code_returned");
  try {
    const redirectUri = process.env.MICROSOFT_REDIRECT_URI || "http://localhost:3000/auth/microsoft/callback";
    const data = await msPost({
      grant_type: "authorization_code",
      client_id: process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      scope: MS_SCOPES,
    });
    const email = await msGetUserEmail(data.access_token);
    const creds = {
      user: email,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      // Microsoft IMAP / SMTP endpoints (OAuth — no basic-auth fallback)
      imapHost: "outlook.office365.com",  imapPort: 993,  imapSecure: true,
      smtpHost: "smtp.office365.com",     smtpPort: 587,  // 587 = STARTTLS
    };
    store.upsertMicrosoft(email, creds);
    console.log("Microsoft account connected:", email);
    res.redirect("/");
  } catch (e) {
    console.error("Microsoft OAuth callback error:", e.message);
    res.redirect("/?error=" + encodeURIComponent("Microsoft sign-in failed: " + e.message));
  }
});

// ── Provider config (used by the smart Add Mailbox modal) ─────────────────────
const PROVIDER_DB = {
  // Google
  'gmail.com':       { id:'google',    name:'Gmail',               oauth:true  },
  'googlemail.com':  { id:'google',    name:'Gmail',               oauth:true  },
  // Microsoft
  'outlook.com':     { id:'microsoft', name:'Outlook',             oauth:true  },
  'hotmail.com':     { id:'microsoft', name:'Hotmail / Outlook',   oauth:true  },
  'hotmail.co.in':   { id:'microsoft', name:'Hotmail / Outlook',   oauth:true  },
  'live.com':        { id:'microsoft', name:'Outlook / Live',      oauth:true  },
  'live.in':         { id:'microsoft', name:'Outlook / Live',      oauth:true  },
  'msn.com':         { id:'microsoft', name:'Microsoft',           oauth:true  },
  'outlook.co.in':   { id:'microsoft', name:'Outlook India',       oauth:true  },
  // Zoho (imap varies by datacenter)
  'zohomail.com':    { id:'zoho', name:'Zoho Mail',        imap:{imapHost:'imap.zoho.com', imapPort:993, smtpHost:'smtp.zoho.com', smtpPort:465}, appPwUrl:'https://accounts.zoho.com/home#security/app-passwords' },
  'zoho.com':        { id:'zoho', name:'Zoho Mail',        imap:{imapHost:'imap.zoho.com', imapPort:993, smtpHost:'smtp.zoho.com', smtpPort:465}, appPwUrl:'https://accounts.zoho.com/home#security/app-passwords' },
  'zohomail.in':     { id:'zoho', name:'Zoho Mail India',  imap:{imapHost:'imap.zoho.in',  imapPort:993, smtpHost:'smtp.zoho.in',  smtpPort:465}, appPwUrl:'https://accounts.zoho.in/home#security/app-passwords' },
  'zoho.in':         { id:'zoho', name:'Zoho Mail India',  imap:{imapHost:'imap.zoho.in',  imapPort:993, smtpHost:'smtp.zoho.in',  smtpPort:465}, appPwUrl:'https://accounts.zoho.in/home#security/app-passwords' },
  // Yahoo
  'yahoo.com':       { id:'yahoo', name:'Yahoo Mail', imap:{imapHost:'imap.mail.yahoo.com', imapPort:993, smtpHost:'smtp.mail.yahoo.com', smtpPort:465}, appPwUrl:'https://login.yahoo.com/account/security' },
  'yahoo.co.in':     { id:'yahoo', name:'Yahoo Mail', imap:{imapHost:'imap.mail.yahoo.com', imapPort:993, smtpHost:'smtp.mail.yahoo.com', smtpPort:465}, appPwUrl:'https://login.yahoo.com/account/security' },
  'ymail.com':       { id:'yahoo', name:'Yahoo Mail', imap:{imapHost:'imap.mail.yahoo.com', imapPort:993, smtpHost:'smtp.mail.yahoo.com', smtpPort:465}, appPwUrl:'https://login.yahoo.com/account/security' },
  // Apple iCloud
  'icloud.com':      { id:'icloud', name:'iCloud Mail', imap:{imapHost:'imap.mail.me.com', imapPort:993, smtpHost:'smtp.mail.me.com', smtpPort:587}, appPwUrl:'https://appleid.apple.com/account/manage' },
  'me.com':          { id:'icloud', name:'iCloud Mail', imap:{imapHost:'imap.mail.me.com', imapPort:993, smtpHost:'smtp.mail.me.com', smtpPort:587}, appPwUrl:'https://appleid.apple.com/account/manage' },
  'mac.com':         { id:'icloud', name:'iCloud Mail', imap:{imapHost:'imap.mail.me.com', imapPort:993, smtpHost:'smtp.mail.me.com', smtpPort:587}, appPwUrl:'https://appleid.apple.com/account/manage' },
  // ProtonMail
  'proton.me':       { id:'proton', name:'Proton Mail', bridge:true },
  'protonmail.com':  { id:'proton', name:'Proton Mail', bridge:true },
  'pm.me':           { id:'proton', name:'Proton Mail', bridge:true },
  // Fastmail
  'fastmail.com':    { id:'fastmail', name:'Fastmail', imap:{imapHost:'imap.fastmail.com', imapPort:993, smtpHost:'smtp.fastmail.com', smtpPort:465}, appPwUrl:'https://www.fastmail.com/settings/security/u-apppasswords' },
  'fastmail.fm':     { id:'fastmail', name:'Fastmail', imap:{imapHost:'imap.fastmail.com', imapPort:993, smtpHost:'smtp.fastmail.com', smtpPort:465}, appPwUrl:'https://www.fastmail.com/settings/security/u-apppasswords' },
  // Rediff (India)
  'rediffmail.com':  { id:'rediff', name:'Rediff Mail', imap:{imapHost:'imap.rediffmail.com', imapPort:993, smtpHost:'smtp.rediffmail.com', smtpPort:587} },
};

app.get("/api/provider-config", (req, res) => {
  const email   = (req.query.email || "").toLowerCase().trim();
  const domain  = email.split("@")[1] || "";
  const provider = PROVIDER_DB[domain] || null;
  // Tell the client whether Zoho / Yahoo OAuth is actually configured
  const zohoReady  = !!(process.env.ZOHO_CLIENT_ID  && process.env.ZOHO_CLIENT_SECRET);
  const yahooReady = !!(process.env.YAHOO_CLIENT_ID && process.env.YAHOO_CLIENT_SECRET);
  if (provider?.id === 'zoho')  provider.oauthReady = zohoReady;
  if (provider?.id === 'yahoo') provider.oauthReady = yahooReady;
  res.json({ domain, provider });
});

// ── Zoho OAuth ─────────────────────────────────────────────────────────────────
function zohoBase() {
  return (process.env.ZOHO_DC || 'com') === 'in'
    ? 'https://accounts.zoho.in' : 'https://accounts.zoho.com';
}
function zohoPost(params) {
  const body = Object.entries(params).map(([k,v]) => encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');
  const url  = new URL(zohoBase() + '/oauth/v2/token');
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: url.hostname, path: url.pathname,
      method: 'POST', headers: { 'Content-Type':'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let d = ''; res.on('data', c => d+=c);
      res.on('end', () => { try { const j=JSON.parse(d); if(j.error) return reject(new Error(j.error)); resolve(j); } catch(e){reject(e);} });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

app.get("/auth/zoho", (req, res) => {
  const clientId = process.env.ZOHO_CLIENT_ID;
  if (!clientId) return res.status(500).send("ZOHO_CLIENT_ID not set in .env — see setup guide.");
  const redirectUri = process.env.ZOHO_REDIRECT_URI || "http://localhost:3000/auth/zoho/callback";
  const params = new URLSearchParams({
    client_id: clientId, response_type: "code", redirect_uri: redirectUri,
    scope: "ZohoMail.messages.READ,ZohoMail.messages.CREATE,ZohoMail.messages.UPDATE,ZohoMail.folders.READ,ZohoMail.accounts.READ,IMAP.AccessToken",
    access_type: "offline", prompt: "consent",
  });
  res.redirect(zohoBase() + "/oauth/v2/auth?" + params.toString());
});

app.get("/auth/zoho/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect("/?error=zoho_auth_cancelled");
  try {
    const redirectUri = process.env.ZOHO_REDIRECT_URI || "http://localhost:3000/auth/zoho/callback";
    const tok = await zohoPost({ grant_type:"authorization_code", client_id:process.env.ZOHO_CLIENT_ID, client_secret:process.env.ZOHO_CLIENT_SECRET, code, redirect_uri:redirectUri });
    // Get user email from Zoho Mail API
    const dc = (process.env.ZOHO_DC || 'com') === 'in' ? 'in' : 'com';
    let email = null;
    try {
      const acctData = await new Promise((res2, rej2) => {
        const r = https.request({ hostname:`mail.zoho.${dc}`, path:'/api/accounts',
          headers:{ Authorization:`Zoho-oauthtoken ${tok.access_token}` }
        }, (resp) => { let d=''; resp.on('data',c=>d+=c); resp.on('end',()=>{ try{res2(JSON.parse(d));}catch{res2({});} }); });
        r.on('error', rej2); r.end();
      });
      email = acctData?.data?.[0]?.emailAddress || null;
    } catch {}
    const creds = {
      user: email, accessToken: tok.access_token, refreshToken: tok.refresh_token,
      expiresAt: Date.now() + (tok.expires_in || 3600) * 1000, provider: 'zoho',
      imapHost: `imap.zoho.${dc}`, imapPort: 993, imapSecure: true,
      smtpHost: `smtp.zoho.${dc}`, smtpPort: 465,
    };
    store.addImap(email, email, creds);
    console.log("Zoho account connected:", email);
    res.redirect("/");
  } catch (e) {
    console.error("Zoho OAuth error:", e.message);
    res.redirect("/?error=" + encodeURIComponent("Zoho sign-in failed: " + e.message));
  }
});

// ── Yahoo OAuth ─────────────────────────────────────────────────────────────────
function yahooPost(params) {
  const clientId     = process.env.YAHOO_CLIENT_ID;
  const clientSecret = process.env.YAHOO_CLIENT_SECRET;
  const body = Object.entries(params).map(([k,v]) => encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');
  const auth = Buffer.from(clientId + ':' + clientSecret).toString('base64');
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.login.yahoo.com', path: '/oauth2/get_token',
      method: 'POST', headers: { 'Content-Type':'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + auth, 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let d = ''; res.on('data', c => d+=c);
      res.on('end', () => { try { const j=JSON.parse(d); if(j.error) return reject(new Error(j.error_description||j.error)); resolve(j); } catch(e){reject(e);} });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

app.get("/auth/yahoo", (req, res) => {
  const clientId = process.env.YAHOO_CLIENT_ID;
  if (!clientId) return res.status(500).send("YAHOO_CLIENT_ID not set in .env — see setup guide.");
  const redirectUri = process.env.YAHOO_REDIRECT_URI || "http://localhost:3000/auth/yahoo/callback";
  const params = new URLSearchParams({
    client_id: clientId, response_type: "code", redirect_uri: redirectUri,
    scope: "mail-r mail-w", language: "en-us",
  });
  res.redirect("https://api.login.yahoo.com/oauth2/request_auth?" + params.toString());
});

app.get("/auth/yahoo/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect("/?error=yahoo_auth_cancelled");
  try {
    const redirectUri = process.env.YAHOO_REDIRECT_URI || "http://localhost:3000/auth/yahoo/callback";
    const tok = await yahooPost({ grant_type:"authorization_code", code, redirect_uri:redirectUri });
    // Yahoo returns xoauth_yahoo_guid; get email from profile
    let email = null;
    try {
      const profileData = await new Promise((res2, rej2) => {
        const r = https.request({ hostname:'api.login.yahoo.com', path:'/openid/v1/userinfo',
          headers:{ Authorization:`Bearer ${tok.access_token}` }
        }, (resp) => { let d=''; resp.on('data',c=>d+=c); resp.on('end',()=>{ try{res2(JSON.parse(d));}catch{res2({});} }); });
        r.on('error', rej2); r.end();
      });
      email = profileData?.email || null;
    } catch {}
    const creds = {
      user: email, accessToken: tok.access_token, refreshToken: tok.refresh_token,
      expiresAt: Date.now() + (tok.expires_in || 3600) * 1000, provider: 'yahoo',
      imapHost: 'imap.mail.yahoo.com', imapPort: 993, imapSecure: true,
      smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465,
    };
    store.addImap(email, email, creds);
    console.log("Yahoo account connected:", email);
    res.redirect("/");
  } catch (e) {
    console.error("Yahoo OAuth error:", e.message);
    res.redirect("/?error=" + encodeURIComponent("Yahoo sign-in failed: " + e.message));
  }
});

// Sign out = remove the active account; others (if any) remain.
app.get("/auth/logout", (req, res) => {
  const active = store.getActiveAccount();
  if (active) store.removeAccount(active.id);
  res.json({ ok: true, remaining: store.listAccounts().length });
});
app.get("/auth/status", (req, res) => {
  const accounts = store.listAccounts();
  const active = accounts.find(a => a.active) || accounts[0];
  res.json({ authenticated: accounts.length > 0, email: active?.email, activeId: active?.id, accounts });
});

// ── Account management ─────────────────────────────────────────────────────────
app.get("/api/accounts", (req, res) => res.json({ accounts: store.listAccounts(), presets: imap.PRESETS }));

app.post("/api/accounts/:id/activate", (req, res) => { store.setActive(parseInt(req.params.id)); res.json({ ok: true }); });
app.delete("/api/accounts/:id", (req, res) => { store.removeAccount(parseInt(req.params.id)); res.json({ ok: true, remaining: store.listAccounts().length }); });

app.post("/api/accounts/imap", async (req, res) => {
  try {
    const { email, label, user, pass, imapHost, imapPort, imapSecure, smtpHost, smtpPort } = req.body;
    if (!user || !pass || !imapHost || !smtpHost) return res.status(400).json({ error: "user, pass, imapHost and smtpHost are required" });
    const creds = {
      user, pass, imapHost, smtpHost,
      imapPort: parseInt(imapPort) || 993, imapSecure: imapSecure !== false,
      smtpPort: parseInt(smtpPort) || 465,
    };
    await imap.testConnection(creds);              // throws if login/host is wrong
    const id = store.addImap(email || user, label || email || user, creds);
    res.json({ ok: true, id });
  } catch (e) {
    const detail = e.responseText || e.response || e.message || "unknown error";
    console.error("Add IMAP error:", detail, e.code || "");
    let msg = "Connection failed: " + detail;
    if (e.authenticationFailed || /auth|login|credential|basic|disabled/i.test(detail)) {
      // Provider-aware error hint
      const host = (req.body.imapHost || "").toLowerCase();
      let hint = "Check the app password is correct (16 chars).";
      if (/zoho/i.test(host)) {
        hint = "Zoho login rejected. Two common causes:\n" +
               "1. IMAP not enabled — go to Zoho Mail → Settings → Mail → IMAP Access → Enable.\n" +
               "2. Wrong app password — regenerate at accounts.zoho.com/home#security/app-passwords";
      } else if (/outlook|office365|microsoft/i.test(host)) {
        hint = "Outlook/Microsoft 365 has disabled basic-auth IMAP for most accounts. " +
               "Use 'Sign in with Microsoft' (OAuth) instead.";
      } else if (/yahoo/i.test(host)) {
        hint = "Yahoo login rejected. Generate an app password at login.yahoo.com/account/security.";
      } else if (/icloud|apple|me\.com/i.test(host)) {
        hint = "iCloud login rejected. Generate an app-specific password at appleid.apple.com.";
      }
      msg = "Login rejected by the server. " + hint;
    }
    res.status(400).json({ error: msg });
  }
});

// ── All Mail — fetch inbox from every connected account and merge ─────────────
app.get("/api/emails/all", async (req, res) => {
  try {
    // listAccounts() strips secrets — re-fetch each with withSecret=true
    const accounts = store.listAccounts().map(a => store.getAccount(a.id, true)).filter(Boolean);
    const allEmails = [];

    await Promise.all(accounts.map(async (acc) => {
      try {
        let emails = [];

        if (acc.type === "imap") {
          const result = await imap.list(acc.secret, { q: "in:inbox" });
          emails = result.emails || [];

        } else if (acc.type === "microsoft") {
          let secret = acc.secret || {};
          if (secret.refreshToken && (!secret.expiresAt || Date.now() > secret.expiresAt - 60_000)) {
            try {
              const refreshed = await refreshMicrosoftToken(secret.refreshToken);
              secret = { ...secret, ...refreshed };
              store.updateSecret(acc.id, secret, acc.email);
            } catch {}
          }
          if (secret.accessToken) {
            const result = await graph.list(secret.accessToken, acc.email, { q: "in:inbox" });
            emails = result.emails || [];
          }

        } else if (acc.type === "gmail") {
          if (!acc.secret) return;
          const oauth2 = makeOAuth2Client();
          oauth2.setCredentials(acc.secret);
          oauth2.on("tokens", t => store.updateSecret(acc.id, { ...acc.secret, ...t }, acc.email));
          const gmail = google.gmail({ version: "v1", auth: oauth2 });
          const threadsRes = await gmail.users.threads.list({ userId: "me", q: "in:inbox", maxResults: 20 });
          const threads = threadsRes.data.threads || [];
          const threadEmails = await Promise.all(threads.map(async t => {
            try {
              const thread = await gmail.users.threads.get({ userId: "me", id: t.id, format: "metadata",
                metadataHeaders: ["From", "To", "Cc", "Subject", "Date"] });
              const msgs = thread.data.messages || [];
              const first = msgs[0], last = msgs[msgs.length - 1] || first;
              const hdr = (m, n) => (m?.payload?.headers||[]).find(h=>h.name.toLowerCase()===n.toLowerCase())?.value||"";
              return {
                id: t.id, subject: hdr(first,"Subject")||"(no subject)",
                sender: hdr(last,"From"), to: hdr(last,"To"), cc: hdr(last,"Cc"),
                date: hdr(last,"Date"), snippet: htmlToText(last?.snippet||""),
                _sortTs: Number(last?.internalDate) || 0,
                count: msgs.length,
                unread: msgs.some(m=>(m.labelIds||[]).includes("UNREAD")),
                starred: msgs.some(m=>(m.labelIds||[]).includes("STARRED")),
                importance: msgs.some(m=>(m.labelIds||[]).includes("IMPORTANT")) ? "high" : "normal",
                categories: [],
              };
            } catch { return null; }
          }));
          emails = threadEmails.filter(Boolean);
        }

        // Tag every email with its originating account
        emails.forEach(e => { e._accountId = acc.id; e._accountEmail = acc.email; e._accountType = acc.type; });
        allEmails.push(...emails);
      } catch (e) {
        console.error(`All Mail — account ${acc.id} (${acc.email}):`, e.message);
      }
    }));

    // Newest first — prefer _sortTs (epoch-ms from internalDate, reliable); fall back to Date header parse
    allEmails.sort((a, b) => (b._sortTs || Date.parse(b.date) || 0) - (a._sortTs || Date.parse(a.date) || 0));
    res.json({ emails: allEmails.slice(0, 80), nextPageToken: null });
  } catch (e) {
    console.error("All Mail error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Gmail routes ──────────────────────────────────────────────────────────────
app.get("/api/emails", withAuth, async (req, res) => {
  try {
    if (req.account.type === "microsoft") {
      return res.json(await graph.list(req.graphToken, req.account.email, { q: req.query.q || "in:inbox", pageToken: req.query.pageToken }));
    }
    if (req.account.type === "imap") {
      return res.json(await imap.list(req.account.secret, { q: req.query.q || "in:inbox", pageToken: req.query.pageToken }));
    }
    const { q = "in:inbox", maxResults = 100, pageToken } = req.query;
    const wantCount = Math.min(parseInt(maxResults) || 100, 200);
    // IMPORTANT: use messages.list, NOT threads.list. threads.list orders threads by their
    // FIRST message's date, so a long-running conversation whose newest reply is today gets
    // buried past page 1 (and missed entirely). messages.list is sorted by actual message
    // date (internalDate desc), so recent replies always surface. We then dedupe messages
    // into threads, preserving that recency order.
    const msgsRes = await req.gmail.users.messages.list({
      userId: "me", q, maxResults: wantCount,
      ...(pageToken ? { pageToken } : {}),
    });
    const nextPageToken = msgsRes.data.nextPageToken || null;
    const rawMsgs = msgsRes.data.messages || [];
    if (!rawMsgs.length) return res.json({ emails: [], nextPageToken });
    // Dedupe into unique threads, keeping first (most-recent) occurrence order
    const seenThreads = new Set();
    const threads = [];
    for (const m of rawMsgs) {
      if (!seenThreads.has(m.threadId)) { seenThreads.add(m.threadId); threads.push({ id: m.threadId }); }
    }

    const emails = await Promise.all(threads.map(async (t) => {
      try {
        const thread = await req.gmail.users.threads.get({
          userId: "me", id: t.id, format: "metadata",
          metadataHeaders: ["From", "To", "Cc", "Subject", "Date"],
        });
        const msgs = thread.data.messages || [];
        const firstMsg = msgs[0];
        const lastMsg = msgs[msgs.length - 1] || firstMsg;
        const hdr = (m, name) => (m?.payload?.headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";
        // If the user sent the last message, show the OTHER party (not yourself) as sender
        const myEmail = (req.account.email || "").toLowerCase();
        const lastFrom = hdr(lastMsg, "From").toLowerCase();
        // Guard against blank myEmail: ''.includes('') is always true, which would mark
        // every thread as sent-by-me and break the conversation-partner display.
        const isSentByMe = !!myEmail && lastFrom.includes(myEmail);
        // Find the most recent message NOT from the user to show as the conversation partner
        const otherMsg = isSentByMe
          ? [...msgs].reverse().find(m => !hdr(m, "From").toLowerCase().includes(myEmail)) || firstMsg
          : lastMsg;
        return {
          id: t.id, messageId: lastMsg?.id,
          subject: hdr(firstMsg, "Subject") || "(no subject)",
          sender: hdr(otherMsg, "From"),  // always show conversation partner, not yourself
          to: hdr(lastMsg, "To"),
          cc: hdr(lastMsg, "Cc"),
          date: hdr(lastMsg, "Date"),     // latest activity time (display only)
          _sortTs: Number(lastMsg?.internalDate) || 0,  // Gmail epoch-ms — reliable sort key (not the spoofable Date header)
          snippet: htmlToText(lastMsg?.snippet || ""),
          count: msgs.length,             // number of messages in the conversation
          unread: msgs.some(m => (m.labelIds || []).includes("UNREAD")),
          starred: msgs.some(m => (m.labelIds || []).includes("STARRED")),
          // Gmail's own priority signal — the IMPORTANT label (yellow arrow in Gmail)
          importance: msgs.some(m => (m.labelIds || []).includes("IMPORTANT")) ? "high" : "normal",
          categories: [],
        };
      } catch (threadErr) {
        console.error("Thread parse error:", t.id, threadErr.message);
        return null;
      }
    }));
    // Re-sort by Gmail internalDate desc (reliable epoch-ms; falls back to Date header parse).
    const out = emails.filter(Boolean).sort((a, b) =>
      (b._sortTs || Date.parse(b.date) || 0) - (a._sortTs || Date.parse(a.date) || 0));
    res.json({ emails: out, nextPageToken });
  } catch (e) {
    console.error("List emails error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/emails/:threadId", withAuth, async (req, res) => {
  try {
    if (req.account.type === "microsoft") {
      return res.json(await graph.getThread(req.graphToken, req.params.threadId));
    }
    if (req.account.type === "imap") {
      const folder = req.query.folder || "INBOX";
      return res.json(await imap.getThread(req.account.secret, req.params.threadId, folder));
    }
    const thread = await req.gmail.users.threads.get({ userId: "me", id: req.params.threadId, format: "full" });
    const messages = (thread.data.messages || []).map((msg) => {
      const headers = msg.payload?.headers || [];
      const get = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";

      // Decode a MIME part using the charset declared in its Content-Type header
      // (emails are often windows-1252 / ISO-8859-1, not UTF-8 — decoding as UTF-8 corrupts them to "?").
      function decodePart(part) {
        const buf = Buffer.from(part.body.data, "base64");
        const ctype = (part.headers || []).find(h => h.name.toLowerCase() === "content-type")?.value || "";
        const charset = (ctype.match(/charset=["']?([^;"'\s]+)/i)?.[1] || "utf-8").toLowerCase();
        return iconv.encodingExists(charset) ? iconv.decode(buf, charset) : buf.toString("utf-8");
      }

      let plain = "", html = "";
      const attachments = [];
      function walk(parts) {
        if (!parts) return;
        for (const part of parts) {
          if (part.body?.data && part.mimeType === "text/plain") plain += decodePart(part);
          else if (part.body?.data && part.mimeType === "text/html") html += decodePart(part);
          else if (part.parts) walk(part.parts);
          else if (part.body?.attachmentId) {
            const cdHeader = (part.headers || []).find(h => h.name.toLowerCase() === "content-disposition")?.value || "";
            const fname = cdHeader.match(/filename\*?=["']?(?:UTF-8'')?([^"';\n]+)/i)?.[1]
              || part.filename || `attachment`;
            const bytes = part.body.size || 0;
            attachments.push({
              attachmentId: part.body.attachmentId,
              filename: decodeURIComponent(fname).trim(),
              contentType: part.mimeType || "application/octet-stream",
              size: bytes,
              sizeStr: bytes > 1048576 ? (bytes/1048576).toFixed(1)+' MB' : bytes > 1024 ? (bytes/1024).toFixed(1)+' KB' : bytes+' B',
            });
          }
        }
      }
      if (msg.payload?.body?.data) {
        if (msg.payload.mimeType === "text/html") html = decodePart(msg.payload);
        else plain = decodePart(msg.payload);
      } else {
        walk(msg.payload?.parts);
      }

      // Some senders dump raw HTML into the "plain" part, so strip tags whenever
      // the chosen body still looks like HTML — not only when a plain part is missing.
      const looksHtml = (s) => /<\/?(?:!doctype|html|head|body|table|tr|td|div|p|br|span|a|meta|img)[\s/>]/i.test(s);
      let body = plain;
      if (!body.trim() || looksHtml(body)) {
        const src = html && html.trim() ? html : plain;
        body = htmlToText(src);
      }
      return { id: msg.id, from: get("From"), to: get("To"), cc: get("Cc"), subject: get("Subject"), date: get("Date"), headerMessageId: get("Message-ID"), body: body.trim(), html: (html || "").trim(), attachments };
    });
    res.json({ threadId: req.params.threadId, _type: 'gmail', messages });
  } catch (e) {
    console.error("Get thread error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/drafts", withAuth, async (req, res) => {
  try {
    const { threadId, to, subject, body, inReplyTo, references } = req.body;
    if (!body) return res.status(400).json({ error: "body required" });
    if (req.account.type === "microsoft") {
      const id = await graph.saveDraft(req.graphToken, { to, subject, body });
      return res.json({ ok: true, draftId: id });
    }
    if (req.account.type === "imap") {
      await imap.saveDraft(req.account.secret, { to, subject, body, inReplyTo, references });
      return res.json({ ok: true });
    }
    const raw = await buildGmailRaw({ from: req.account.email, to, subject, body, inReplyTo, references });
    const draft = await req.gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw, ...(threadId ? { threadId } : {}) } },
    });
    res.json({ ok: true, draftId: draft.data.id });
  } catch (e) {
    console.error("Save draft error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

const _sendRateMap = new Map();
function checkSendRate(id) {
  const now = Date.now(), win = 60_000, max = 10;
  const times = (_sendRateMap.get(id) || []).filter(t => now - t < win);
  times.push(now);
  _sendRateMap.set(id, times);
  return times.length <= max;
}

app.post("/api/send", withAuth, async (req, res) => {
  if (!checkSendRate(req.sessionID))
    return res.status(429).json({ error: "Sending too fast — wait a minute before sending again" });
  try {
    const { threadId, to, cc, bcc, subject, body, html, inReplyTo, references, attachments } = req.body;
    if (!to) return res.status(400).json({ error: "recipient required" });

    if (req.account.type === "microsoft") {
      await graph.send(req.graphToken, { to, cc, bcc, subject, body, html, inReplyTo, attachments });
      return res.json({ ok: true });
    }
    if (req.account.type === "imap") {
      const id = await imap.send(req.account.secret, { to, cc, bcc, subject, body, html, inReplyTo, references, attachments });
      return res.json({ ok: true, id });
    }
    // Gmail — use MailComposer to support attachments + HTML
    const raw = await buildGmailRaw({
      from: req.account.email,
      to, cc, bcc, subject, body, html, inReplyTo, references, attachments,
    });
    const sent = await req.gmail.users.messages.send({
      userId: "me",
      requestBody: { raw, ...(threadId ? { threadId } : {}) },
    });
    res.json({ ok: true, id: sent.data.id });
  } catch (e) {
    console.error("Send error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Thread actions (require gmail.modify scope) ───────────────────────────────
async function modifyThread(req, addLabelIds = [], removeLabelIds = []) {
  return req.gmail.users.threads.modify({
    userId: "me", id: req.params.id,
    requestBody: { addLabelIds, removeLabelIds },
  });
}

app.post("/api/threads/:id/archive", withAuth, async (req, res) => {
  try {
    if (req.account.type === "microsoft") { await graph.archive(req.graphToken, req.params.id); return res.json({ ok: true }); }
    if (req.account.type === "imap") { await imap.archive(req.account.secret, req.params.id, req.body?.folder || "INBOX"); return res.json({ ok: true }); }
    await modifyThread(req, [], ["INBOX"]); res.json({ ok: true });
  } catch (e) { console.error("Archive error:", e.message); res.status(500).json({ error: e.message }); }
});

app.post("/api/threads/:id/read", withAuth, async (req, res) => {
  try {
    const read = req.body?.read !== false;
    if (req.account.type === "microsoft") { await graph.setRead(req.graphToken, req.params.id, read); return res.json({ ok: true, read }); }
    if (req.account.type === "imap") { await imap.setRead(req.account.secret, req.params.id, read, req.body?.folder || "INBOX"); return res.json({ ok: true, read }); }
    await modifyThread(req, read ? [] : ["UNREAD"], read ? ["UNREAD"] : []);
    res.json({ ok: true, read });
  } catch (e) { console.error("Read toggle error:", e.message); res.status(500).json({ error: e.message }); }
});

app.post("/api/threads/:id/star", withAuth, async (req, res) => {
  try {
    const star = req.body?.star !== false;
    if (req.account.type === "microsoft") { await graph.setStar(req.graphToken, req.params.id, star); return res.json({ ok: true, star }); }
    if (req.account.type === "imap") { await imap.setStar(req.account.secret, req.params.id, star, req.body?.folder || "INBOX"); return res.json({ ok: true, star }); }
    await modifyThread(req, star ? ["STARRED"] : [], star ? [] : ["STARRED"]);
    res.json({ ok: true, star });
  } catch (e) { console.error("Star toggle error:", e.message); res.status(500).json({ error: e.message }); }
});

app.post("/api/threads/:id/trash", withAuth, async (req, res) => {
  try {
    if (req.account.type === "microsoft") { await graph.trash(req.graphToken, req.params.id); return res.json({ ok: true }); }
    if (req.account.type === "imap") { await imap.trash(req.account.secret, req.params.id, req.body?.folder || "INBOX"); return res.json({ ok: true }); }
    await req.gmail.users.threads.trash({ userId: "me", id: req.params.id }); res.json({ ok: true });
  } catch (e) { console.error("Trash error:", e.message); res.status(500).json({ error: e.message }); }
});

// ── Mark all as read in current folder ───────────────────────────────────────
app.post("/api/mark-all-read", withAuth, async (req, res) => {
  try {
    const { q = 'in:inbox', folder = 'INBOX' } = req.body;
    if (req.account.type === "microsoft") {
      const gf = /in:sent/i.test(q) ? 'sentitems'
               : /in:trash/i.test(q) ? 'deleteditems'
               : /in:spam/i.test(q)  ? 'junkemail'
               : /in:drafts/i.test(q) ? 'drafts'
               : /in:archive/i.test(q) ? 'archive'
               : 'inbox';
      const result = await graph.markAllRead(req.graphToken, gf);
      return res.json({ ok: true, ...result });
    }
    if (req.account.type === "imap") {
      const result = await imap.markAllRead(req.account.secret, folder);
      return res.json({ ok: true, ...result });
    }
    // Gmail
    const msgs = await req.gmail.users.messages.list({ userId: 'me', q: q + ' is:unread', maxResults: 500 });
    const ids = (msgs.data.messages || []).map(m => m.id);
    if (ids.length) {
      await req.gmail.users.messages.batchModify({ userId: 'me', requestBody: { ids, removeLabelIds: ['UNREAD'] } });
    }
    res.json({ ok: true, count: ids.length });
  } catch (e) {
    console.error("Mark all read error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Empty Trash — permanently delete all messages in trash ────────────────────
app.post("/api/empty-trash", withAuth, async (req, res) => {
  try {
    if (req.account.type === "microsoft") {
      const result = await graph.emptyTrash(req.graphToken);
      return res.json({ ok: true, ...result });
    }
    if (req.account.type === "imap") {
      const result = await imap.emptyTrash(req.account.secret);
      return res.json({ ok: true, ...result });
    }
    // Gmail: list + batchDelete (may need multiple rounds)
    let total = 0, pageToken;
    do {
      const result = await req.gmail.users.messages.list({
        userId: 'me', q: 'in:trash', maxResults: 500,
        ...(pageToken ? { pageToken } : {})
      });
      const ids = (result.data.messages || []).map(m => m.id);
      if (ids.length) {
        await req.gmail.users.messages.batchDelete({ userId: 'me', requestBody: { ids } });
        total += ids.length;
      }
      pageToken = result.data.nextPageToken;
    } while (pageToken);
    res.json({ ok: true, count: total });
  } catch (e) {
    console.error("Empty trash error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Attachment download ───────────────────────────────────────────────────────
// IMAP: GET /api/attachments/imap/:uid/:idx?folder=Sent
app.get("/api/attachments/imap/:uid/:idx", withAuth, async (req, res) => {
  try {
    if (req.account.type !== "imap") return res.status(400).json({ error: "imap accounts only" });
    const folder = req.query.folder || "INBOX";
    const att = await imap.getAttachment(req.account.secret, req.params.uid, req.params.idx, folder);
    res.setHeader("Content-Type", att.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(att.filename)}"`);
    res.send(att.content);
  } catch (e) { console.error("Attachment error:", e.message); res.status(500).json({ error: e.message }); }
});

// Gmail: GET /api/attachments/gmail/:msgId/:attId
app.get("/api/attachments/gmail/:msgId/:attId", withAuth, async (req, res) => {
  try {
    if (req.account.type !== "gmail") return res.status(400).json({ error: "gmail accounts only" });
    const att = await req.gmail.users.messages.attachments.get({
      userId: "me", messageId: req.params.msgId, id: req.params.attId,
    });
    const buf = Buffer.from(att.data.data, "base64");
    const fname = req.query.filename || "attachment";
    res.setHeader("Content-Type", req.query.contentType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(fname)}"`);
    res.send(buf);
  } catch (e) { console.error("Gmail attachment error:", e.message); res.status(500).json({ error: e.message }); }
});

// Microsoft: GET /api/attachments/microsoft/:msgId/:attId
app.get("/api/attachments/microsoft/:msgId/:attId", withAuth, async (req, res) => {
  try {
    if (req.account.type !== "microsoft") return res.status(400).json({ error: "microsoft accounts only" });
    const https = require("https");
    const token = req.graphToken;
    const path = `/v1.0/me/messages/${req.params.msgId}/attachments/${req.params.attId}`;
    const data = await new Promise((resolve, reject) => {
      const r = https.request({ hostname: "graph.microsoft.com", path, method: "GET",
        headers: { Authorization: "Bearer " + token, Accept: "application/json" }
      }, (res2) => {
        let d = ""; res2.on("data", c => d += c); res2.on("end", () => {
          try { resolve(JSON.parse(d)); } catch { reject(new Error("parse error")); }
        });
      });
      r.on("error", reject); r.end();
    });
    if (data.error) return res.status(500).json({ error: data.error.message });
    const buf = Buffer.from(data.contentBytes || "", "base64");
    const fname = req.query.filename || data.name || "attachment";
    res.setHeader("Content-Type", data.contentType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(fname)}"`);
    res.send(buf);
  } catch (e) { console.error("MS attachment error:", e.message); res.status(500).json({ error: e.message }); }
});

// ── Clear AI cache ────────────────────────────────────────────────────────────
app.post("/api/cache/clear", withAuth, (req, res) => {
  try { store.clearCache(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI: full analysis ──────────────────────────────────────────────────────────
app.post("/api/analyze", withAuth, async (req, res) => {
  try {
    let { emailText, messages, tone = "professional", mode = "full", model, provider, apiKey } = req.body;

    // Build structured thread context — prefer messages array; fall back to flat emailText
    let threadContext;
    if (messages && messages.length) {
      threadContext = formatThreadContext(messages);
    } else if (emailText) {
      threadContext = emailText;
    } else {
      return res.status(400).json({ error: "emailText or messages required" });
    }

    // Trim to ~10 000 chars keeping the most recent content (tail) for context window
    if (threadContext.length > 10000)
      threadContext = "[…earlier messages truncated…]\n\n" + threadContext.slice(-10000);

    // Cache full analyses — keyed on content+tone+provider so different settings get different cache entries
    const cacheKey = mode === "full"
      ? crypto.createHash("sha256").update(`v2|full|${tone}|${provider||DEFAULT_PROVIDER}|${model||DEFAULT_MODEL}|${threadContext}`).digest("hex")
      : null;
    if (cacheKey) {
      const hit = store.getCache(cacheKey);
      if (hit) return res.json({ ...hit, cached: true });
    }

    // mode=reply: compose AI Draft — plain text, no JSON mode
    if (mode === "reply") {
      const replyPrompt = `Draft a complete, ${tone} reply to the LAST message in this thread. Be direct and concise.\n\nTHREAD:\n${threadContext}\n\nReturn ONLY the reply text — no subject line, no preamble, no JSON.`;
      const text = await callAIText(replyPrompt, { provider, model, apiKey });
      return res.json({ reply: text.trim() });
    }

    // mode=full: structured analysis via native JSON mode
    const text = await callAnalysis(threadContext, { provider, model, apiKey, tone });
    let parsed;
    try {
      // JSON mode providers return pure JSON; older/fallback paths may still wrap in fences
      parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text);
    } catch(e) {
      throw new Error("AI did not return valid JSON. Response: " + text.slice(0, 200));
    }
    if (cacheKey) store.setCache(cacheKey, parsed);
    res.json(parsed);
  } catch (e) {
    console.error("Analyze error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── AI: streaming reply (SSE) ─────────────────────────────────────────────────
// Emits:  data: {"chunk":"text"}\n\n  …  data: {"done":true}\n\n
app.post("/api/reply/stream", withAuth, async (req, res) => {
  const { messages, emailText, tone = "professional", model, provider, apiKey } = req.body;
  const threadContext = messages && messages.length
    ? formatThreadContext(messages) : (emailText || "");
  if (!threadContext) return res.status(400).json({ error: "messages or emailText required" });
  await streamReplyToRes(threadContext, { provider, model, apiKey, tone }, res);
});

// ── AI: suggest reply (user describes intent, streamed) ────────────────────────
app.post("/api/suggest-reply", withAuth, async (req, res) => {
  const { messages, emailText, instruction, tone, model, provider, apiKey } = req.body;
  if (!instruction) return res.status(400).json({ error: "instruction required" });
  const threadContext = messages?.length ? formatThreadContext(messages) : (emailText || "");
  // Build a custom prompt that includes the user's instruction
  const customPrompt = `You are drafting an email reply on behalf of the Mailmind user (the RECIPIENT of this thread).

THREAD (chronological — reply to the LAST message):
${threadContext}

User's specific instruction for the reply: "${instruction}"

REQUIREMENTS:
- Follow the user's instruction exactly
- Write FROM the user TO the sender of the last message
- Do NOT echo or restate what the sender said
- Do NOT open with filler phrases ("Thank you for your email", etc.)
- Tone: natural and direct; honour the instruction's implied register
- End with a natural sign-off; do NOT include a name

Return ONLY the email body text. No subject line. No preamble.`;
  // Reuse the streaming infrastructure but inject the custom prompt
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();
  let finished = false;  // one-shot guard against write-after-end (see streamReplyToRes)
  const emit  = t => { if (!finished) res.write(`data: ${JSON.stringify({ chunk: t })}\n\n`); };
  const done  = () => { if (finished) return; finished = true; res.write(`data: ${JSON.stringify({ done: true })}\n\n`); res.end(); };
  const error = e => { if (finished) return; finished = true; res.write(`data: ${JSON.stringify({ error: e })}\n\n`);  res.end(); };
  const p = ((provider || DEFAULT_PROVIDER)).toLowerCase();
  const m = resolveModel(p, model);
  const key = apiKey;
  try {
    if (p === "anthropic") {
      await _streamAnthropic(customPrompt, { apiKey: resolveKey(p, key), model: m }, emit, done, error);
    } else if (p === "gemini") {
      await _streamGemini(customPrompt, { apiKey: resolveKey(p, key), model: m }, emit, done, error);
    } else {
      const h = OPENAI_HOSTS[p] || OPENAI_HOSTS.groq;
      await _streamOpenAI(customPrompt, { ...h, key: resolveKey(p, key), model: m }, emit, done, error);
    }
  } catch(e) { error(e.message); }
});

// ── AI: quick reply chips ─────────────────────────────────────────────────────
app.post("/api/quick-replies", withAuth, async (req, res) => {
  try {
    const { messages, emailText, model, provider, apiKey } = req.body;
    const threadContext = messages && messages.length
      ? formatThreadContext(messages) : (emailText || "");
    if (!threadContext) return res.status(400).json({ error: "messages or emailText required" });
    const chips = await getQuickReplies(threadContext, { provider, model, apiKey });
    res.json({ chips });
  } catch(e) {
    console.error("Quick replies error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── AI: test key + model ───────────────────────────────────────────────────────
app.post("/api/test-ai", withAuth, async (req, res) => {
  const { provider = "groq", model, apiKey } = req.body;
  const p = provider.toLowerCase();
  const m = resolveModel(p, model);
  const key = apiKey?.trim() || process.env[{ openai:"OPENAI_API_KEY", mistral:"MISTRAL_API_KEY", groq:"GROQ_API_KEY", anthropic:"ANTHROPIC_API_KEY", gemini:"GEMINI_API_KEY" }[p] || "GROQ_API_KEY"];
  if (!key) return res.json({ ok: false, error: "No API key provided." });
  try {
    const ping = "Reply with exactly: OK";
    let result = "";
    if (p === "gemini") {
      const body = JSON.stringify({
        contents: [{ parts: [{ text: ping }] }],
        generationConfig: { maxOutputTokens: 10, temperature: 0 },
      });
      try {
        result = await new Promise((resolve, reject) => {
          const req2 = require("https").request({
            hostname: "generativelanguage.googleapis.com",
            path: `/v1beta/models/${m}:generateContent?key=${key}`,
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
          }, r => { let d = ""; r.on("data", c => d += c); r.on("end", () => {
            try {
              const j = JSON.parse(d);
              if (j.error) return reject(new Error(j.error.message || JSON.stringify(j.error)));
              resolve(j.candidates?.[0]?.content?.parts?.[0]?.text || "OK");
            } catch(e) { reject(new Error("Parse error: " + d.slice(0, 200))); }
          }); });
          req2.on("error", reject); req2.write(body); req2.end();
        });
      } catch (e) {
        // Model not found / unsupported → fetch live list so the user knows what works
        if (/not found|not supported|ListModels/i.test(e.message)) {
          try {
            const avail = await new Promise((resolve, reject) => {
              require("https").get(
                `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
                r => { let d = ""; r.on("data", c => d += c); r.on("end", () => {
                  try {
                    const j = JSON.parse(d);
                    if (j.error) return reject(new Error(j.error.message));
                    const names = (j.models || [])
                      .filter(mm => (mm.supportedGenerationMethods || []).includes("generateContent"))
                      .map(mm => (mm.name || "").replace("models/", ""))
                      .filter(n => /gemini/i.test(n) && !/embedding|aqa/i.test(n));
                    resolve(names);
                  } catch (pe) { reject(pe); }
                }); }
              ).on("error", reject);
            });
            return res.json({ ok: false, error: `Model "${m}" not available for your key.`, availableModels: avail });
          } catch (le) { /* fall through to generic error */ }
        }
        throw e;
      }
    } else if (p === "anthropic") {
      const body = JSON.stringify({ model: m, max_tokens: 10, temperature: 0, messages: [{ role:"user", content: ping }] });
      result = await new Promise((resolve, reject) => {
        const req2 = require("https").request({
          hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
          headers: { "Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01","Content-Length":Buffer.byteLength(body) },
        }, r => { let d = ""; r.on("data", c => d += c); r.on("end", () => {
          try { const j = JSON.parse(d); if (j.error) return reject(new Error(j.error.message)); resolve(j.content?.[0]?.text || "OK"); }
          catch(e) { reject(new Error("Parse: " + d.slice(0,200))); }
        }); });
        req2.on("error", reject); req2.write(body); req2.end();
      });
    } else {
      const h = OPENAI_HOSTS[p] || OPENAI_HOSTS.groq;
      const body = JSON.stringify({ model: m, max_tokens: 10, temperature: 0, messages: [{ role:"user", content: ping }] });
      result = await new Promise((resolve, reject) => {
        const req2 = require("https").request({
          hostname: h.hostname, path: h.path, method: "POST",
          headers: { "Content-Type":"application/json","Authorization":"Bearer "+key,"Content-Length":Buffer.byteLength(body) },
        }, r => { let d = ""; r.on("data", c => d += c); r.on("end", () => {
          try { const j = JSON.parse(d); if (j.error) return reject(new Error(j.error.message||JSON.stringify(j.error))); resolve(j.choices?.[0]?.message?.content || "OK"); }
          catch(e) { reject(new Error("Parse: " + d.slice(0,200))); }
        }); });
        req2.setTimeout(15000, () => { req2.destroy(); reject(new Error("Request timed out — check your internet connection")); });
        req2.on("error", reject); req2.write(body); req2.end();
      });
    }
    // Key verified working → persist it (encrypted) so it survives browser/cache clears
    // and works on any device. Only saves a real user-supplied key, not the .env fallback.
    if (apiKey && apiKey.trim()) {
      try { store.saveAISettings({ provider: p, model: m, apiKey: apiKey.trim() }); } catch {}
    }
    res.json({ ok: true, model: m, response: (result || "").trim().slice(0, 80), saved: !!(apiKey && apiKey.trim()) });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── Fetch available models from a provider's API ─────────────────────────────
// Returns { models: [{id, name}] } using the saved API key for that provider.
function httpsGetJson(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error('Parse error: ' + d.slice(0,200))); } });
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.end();
  });
}

app.get('/api/models/:provider', withAuth, async (req, res) => {
  const p = req.params.provider.toLowerCase();
  const settings = store.getAISettings();
  const apiKey = settings.keys[p];
  if (!apiKey) return res.status(400).json({ error: 'No API key saved for ' + p + ' — save and test a key first' });

  try {
    let models = [];
    if (p === 'groq') {
      const data = await httpsGetJson('api.groq.com', '/openai/v1/models', { Authorization: 'Bearer ' + apiKey });
      models = (data.data || [])
        .filter(m => !/whisper|tts|orpheus|compound|guard|tool|vision|embed|allam/i.test(m.id) && !m.id.startsWith('openai/') && !/-[23]b/i.test(m.id))
        .sort((a, b) => (b.created || 0) - (a.created || 0))
        .map(m => ({ id: m.id, name: m.id }));
    } else if (p === 'openai') {
      const data = await httpsGetJson('api.openai.com', '/v1/models', { Authorization: 'Bearer ' + apiKey });
      models = (data.data || [])
        .filter(m => /^(gpt-|o\d|chatgpt)/.test(m.id) && !/realtime|audio|vision|instruct|search|preview.*\d{4}-\d{2}-\d{2}/i.test(m.id))
        .sort((a, b) => (b.created || 0) - (a.created || 0))
        .map(m => ({ id: m.id, name: m.id }));
    } else if (p === 'anthropic') {
      const data = await httpsGetJson('api.anthropic.com', '/v1/models', {
        'x-api-key': apiKey, 'anthropic-version': '2023-06-01',
      });
      models = (data.data || []).map(m => ({ id: m.id, name: m.display_name || m.id }));
    } else if (p === 'gemini') {
      const data = await httpsGetJson('generativelanguage.googleapis.com', '/v1beta/models?key=' + apiKey, {});
      models = (data.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map(m => ({ id: m.name.replace('models/', ''), name: m.displayName || m.name.replace('models/', '') }));
    } else if (p === 'mistral') {
      const data = await httpsGetJson('api.mistral.ai', '/v1/models', { Authorization: 'Bearer ' + apiKey });
      models = (data.data || [])
        .filter(m => !m.capabilities || m.capabilities.completion_chat !== false)
        .map(m => ({ id: m.id, name: m.id }));
    } else {
      return res.status(400).json({ error: 'Unknown provider' });
    }
    res.json({ models });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AI settings: load (keys masked) / save ─────────────────────────────────────
app.get("/api/ai-settings", withAuth, (req, res) => {
  try {
    const s = store.getAISettings();
    // Never return raw keys to the client — only which providers have one saved,
    // plus a masked preview for display.
    const keyInfo = {};
    for (const [prov, k] of Object.entries(s.keys || {})) {
      keyInfo[prov] = { present: !!k, masked: k ? "••••••••" + String(k).slice(-4) : "" };
    }
    res.json({ provider: s.provider || null, models: s.models || {}, keys: keyInfo });
  } catch (e) { res.json({ provider: null, models: {}, keys: {} }); }
});

app.post("/api/ai-settings", withAuth, (req, res) => {
  try {
    const { provider, model, apiKey } = req.body || {};
    const saved = store.saveAISettings({
      provider: provider ? provider.toLowerCase() : undefined,
      model: model || undefined,
      apiKey: (apiKey && apiKey.trim()) ? apiKey.trim() : undefined,
    });
    res.json({ ok: true, provider: saved.provider, models: saved.models });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// Express error-handling middleware (must be last, 4 args). Catches sync throws in routes
// ── Telemetry ingest (NSSM deployment only — disabled on desktop builds) ─────
// Enable by setting MAILMIND_ENABLE_TELEMETRY=true in the NSSM server's .env.
// Payload: { install_uuid, app_version, os, locale, ts } — no email, no name.
// Country is derived from the Cloudflare CF-IPCountry header; the IP itself is
// never stored. Rate-limited to one upsert per UUID per 24 h.
if (process.env.MAILMIND_ENABLE_TELEMETRY === 'true') {
  app.post('/api/telemetry/ping', express.json({ limit: '1kb' }), (req, res) => {
    try {
      const { install_uuid, app_version, os, locale } = req.body || {};
      if (!install_uuid || typeof install_uuid !== 'string' || !/^[0-9a-f]{64}$/.test(install_uuid))
        return res.sendStatus(400);
      const country = ((req.headers['cf-ipcountry'] || 'XX') + '').slice(0, 2).toUpperCase();
      store.telemetryPing({ install_uuid, app_version, os, locale, country });
      res.sendStatus(204);
    } catch (e) {
      console.error('telemetry ping error:', e.message);
      res.sendStatus(500);
    }
  });

  // Read-only stats — protected by MAILMIND_ADMIN_KEY header
  app.get('/api/telemetry/stats', (req, res) => {
    if (!process.env.MAILMIND_ADMIN_KEY || req.headers['x-admin-key'] !== process.env.MAILMIND_ADMIN_KEY)
      return res.sendStatus(403);
    res.json(store.telemetryStats());
  });
}

// and malformed-JSON body-parser errors, returning JSON instead of an HTML error page.
app.use((err, req, res, next) => {
  console.error("Unhandled route error:", err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || "internal error" });
});

// Last-resort process guards so a stray rejection logs instead of silently killing the
// NSSM service mid-request. (uncaughtException leaves the process in an undefined state —
// log and let NSSM restart cleanly rather than limping on.)
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e && e.message ? e.message : e));
process.on("uncaughtException",  (e) => { console.error("uncaughtException:", e && e.stack ? e.stack : e); process.exit(1); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, "127.0.0.1", () => {
  console.log(`\n✅ Mailmind running at http://localhost:${PORT}`);
  console.log(`   AI powered by: Groq LLaMA3 (free)\n`);
});
