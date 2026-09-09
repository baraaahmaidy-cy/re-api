// Always use supabase.auth.getUser(). Never hardcode user IDs.
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();

app.use('/api/resend-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors({
  origin: ['https://therelationshipengine.xyz', 'https://therelationshipengine.netlify.app'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

const RESEND_FULL_ACCESS_KEY = process.env.RESEND_FULL_ACCESS_KEY;
const RESEND_AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID;
const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3001;

// Overridable via env so a deprecated model can be swapped without a code deploy —
// llama-3.3-70b-versatile was removed by Groq and silently broke every AI feature.
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const GROQ_TRANSCRIBE_MODEL = process.env.GROQ_TRANSCRIBE_MODEL || 'whisper-large-v3-turbo';
const API_URL = 'https://api.therelationshipengine.xyz';
const FRONTEND_URL = 'https://therelationshipengine.xyz';
const TELEGRAM_WEBHOOK_URL = `${API_URL}/api/telegram-webhook`;
const ALERT_EMAIL = process.env.ALERT_EMAIL || 'baraaahmaidy@gmail.com';
// A real, monitored reply-to beats a bare noreply@ for deliverability, and a reply
// from a user should actually reach someone.
const EMAIL_FROM = process.env.EMAIL_FROM || 'The Relationship Engine <noreply@therelationshipengine.xyz>';
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || 'baraaahmaidy@gmail.com';

// ── Supabase REST helpers (service role — every call below scopes by user_id explicitly) ──
async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY }
  });
  if (!res.ok) throw new Error(`Supabase GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}
async function sbPost(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Supabase POST ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}
async function sbPatch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}
// Insert-or-update by a unique column — used where a row may already exist from a prior link attempt.
async function sbUpsert(path, body, onConflict) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}${sep}on_conflict=${onConflict}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Supabase UPSERT ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Always use supabase.auth.getUser(). Never hardcode user IDs.
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing authorization token' });
  const token = authHeader.replace('Bearer ', '');
  const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_SERVICE_KEY }
  });
  if (!userResponse.ok) return res.status(401).json({ error: 'Invalid token' });
  const userData = await userResponse.json();
  req.userId = userData.id;
  next();
}

function generateLinkingCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(0, chars.length)];
  return code;
}

// Validates + consumes a linking code, creating the telegram_links row. Returns true on success.
async function tryLinkTelegram(code, chatId, username) {
  const rows = await sbGet(`linking_codes?code=eq.${encodeURIComponent(code)}&used=eq.false&select=*`);
  const row = rows?.[0];
  if (!row || new Date(row.expires_at) < new Date()) return false;
  // Upsert, not insert: this chat may already have a (possibly revoked) telegram_links
  // row from a prior link attempt, and telegram_chat_id is UNIQUE — a plain insert would
  // conflict and throw.
  await sbUpsert('telegram_links', { user_id: row.user_id, telegram_chat_id: chatId, telegram_username: username, status: 'active' }, 'telegram_chat_id');
  await sbPatch(`linking_codes?code=eq.${encodeURIComponent(code)}`, { used: true });
  return true;
}

// Voice notes are the point of the Telegram surface: speaking a note while walking
// out of a meeting is the lowest-friction way to keep a CRM current.
// Groq accepts a fixed set of audio extensions. Telegram serves voice notes from a
// path ending in .oga, which is NOT on that list even though the container is ogg —
// so the filename is derived from the mime type rather than passed through.
const AUDIO_EXT_BY_MIME = {
  'audio/ogg': 'ogg', 'audio/oga': 'ogg', 'audio/opus': 'ogg', 'audio/vorbis': 'ogg',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'm4a',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/webm': 'webm', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
};

async function transcribeTelegramVoice(voice) {
  const fileId = voice.file_id;
  const infoRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`, { signal: AbortSignal.timeout(15000) });
  const info = await infoRes.json();
  const filePath = info?.result?.file_path;
  if (!filePath) throw new Error(`Telegram getFile failed: ${JSON.stringify(info).slice(0, 200)}`);

  const audioRes = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`, { signal: AbortSignal.timeout(30000) });
  if (!audioRes.ok) throw new Error(`Telegram file download failed: ${audioRes.status}`);
  const audio = await audioRes.arrayBuffer();

  const mime = voice.mime_type || 'audio/ogg';
  const ext = AUDIO_EXT_BY_MIME[mime.split(';')[0].trim().toLowerCase()] || 'ogg';

  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime }), `voice.${ext}`);
  form.append('model', GROQ_TRANSCRIBE_MODEL);
  form.append('response_format', 'json');

  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(60000)
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`Groq transcription failed: ${r.status} ${JSON.stringify(d?.error ?? d).slice(0, 200)}`);
  return (d.text || '').trim();
}

async function sendTelegramMessage(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

// Transcription takes a few seconds; show the typing indicator so it doesn't look dead.
async function sendTelegramAction(chatId, action) {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action })
    });
  } catch { /* cosmetic only */ }
}

function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

// Fuzzy match against THIS user's contacts only — caller must have pre-filtered by user_id.
function matchContacts(contacts, query) {
  if (!query) return [];
  const q = String(query).toLowerCase();
  return contacts.filter(c => c.name?.toLowerCase().includes(q));
}

async function classifyTelegramIntent(text, contacts) {
  const today = new Date().toISOString().slice(0, 10);
  const names = contacts.map(c => c.name).join(', ');
  const prompt = `You are an intent classifier for a relationship-management Telegram bot. Today's date is ${today}.
The user's contacts: ${names || '(none)'}.

Classify the message into exactly one JSON object, matching one of these shapes:
- {"intent":"log_interaction","contact_name":"...","note":"..."}
- {"intent":"update_field","contact_name":"...","field":"last_note|role|intention","value":"..."}
- {"intent":"query_contact","contact_name":"..."}
- {"intent":"query_list","filter":"overdue|birthday_month|needs_attention"}
- {"intent":"create_task","contact_name":"...","task_content":"...","due_date":"YYYY-MM-DD or null"}
- {"intent":"query_tasks","filter":"today|this_week|overdue|all_pending"}
- {"intent":"query_calendar","filter":"today|this_week|this_month"}
- {"intent":"unrecognized"}

Resolve relative dates (e.g. "tomorrow", "next Friday") into YYYY-MM-DD using today's date.
Message: "${text}"

Respond with ONLY the JSON object, no other text.`;

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    // Reasoning tokens come out of this budget before any JSON is emitted. At 300
    // a long voice-note transcript could be cut off mid-object, and the parse
    // failure below then read as "I didn't understand you" — the bot blaming the
    // user for its own truncation. The intent object is ~60 tokens; the rest is
    // headroom, and low effort keeps it from being spent.
    body: JSON.stringify({ model: GROQ_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: 2000, reasoning_effort: 'low' })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Groq classify failed: ${response.status} ${JSON.stringify(data)}`);
  const choice = data.choices?.[0];
  const content = choice?.message?.content || '';
  // A truncated or empty completion is our failure, not an unrecognized message.
  // Throwing sends "something went wrong on my end" instead of quietly telling the
  // user their perfectly clear instruction made no sense.
  if (choice?.finish_reason === 'length' || !content.trim()) {
    throw new Error(`Groq classify returned no usable content (finish_reason=${choice?.finish_reason}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  try {
    // Past here, unrecognized is a real verdict about the message itself.
    return jsonMatch ? JSON.parse(jsonMatch[0]) : { intent: 'unrecognized' };
  } catch {
    return { intent: 'unrecognized' };
  }
}

function summarizeContact(c) {
  const parts = [c.name];
  if (c.role) parts.push(c.role);
  const lines = [parts.join(' — ')];
  if (c.tier) lines.push(`Tier: ${c.tier}`);
  if (c.last_contact) lines.push(`Last contact: ${c.last_contact}`);
  if (c.last_note) lines.push(`Last note: ${c.last_note}`);
  if (c.intention) lines.push(`Intention: ${c.intention}`);
  return lines.join('\n');
}

function summarizeList(contacts, filter) {
  let list = contacts;
  if (filter === 'overdue') {
    list = contacts.filter(c => c.cadence_days && daysSince(c.last_contact) > c.cadence_days);
  } else if (filter === 'needs_attention') {
    list = contacts.filter(c => !c.last_contact || daysSince(c.last_contact) > 30);
  } else if (filter === 'birthday_month') {
    const month = new Date().getMonth() + 1;
    list = contacts.filter(c => c.birthday && Number(String(c.birthday).split('-').length === 3 ? c.birthday.split('-')[1] : c.birthday.split('-')[0]) === month);
  }
  if (list.length === 0) return "Nothing matches that right now.";
  return list.slice(0, 15).map(c => `• ${c.name}${c.last_contact ? ` (last contact ${c.last_contact})` : ' (never contacted)'}`).join('\n');
}

function summarizeTasks(contacts, filter) {
  const today = new Date().toISOString().slice(0, 10);
  const weekAhead = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  let tasks = [];
  for (const c of contacts) {
    for (const t of (Array.isArray(c.tasks_json) ? c.tasks_json : [])) {
      if (t.done) continue;
      tasks.push({ ...t, contactName: c.name });
    }
  }
  if (filter === 'today') tasks = tasks.filter(t => t.due === today);
  else if (filter === 'overdue') tasks = tasks.filter(t => t.due && t.due < today);
  else if (filter === 'this_week') tasks = tasks.filter(t => t.due && t.due >= today && t.due <= weekAhead);
  if (tasks.length === 0) return "No pending tasks match that.";
  return tasks.slice(0, 15).map(t => `• ${t.content} — ${t.contactName}${t.due ? ` (due ${t.due})` : ''}`).join('\n');
}

function summarizeCalendar(contacts, filter) {
  const today = new Date().toISOString().slice(0, 10);
  const rangeEnd = filter === 'this_month'
    ? new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
    : filter === 'this_week'
      ? new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
      : today;
  const items = [];
  for (const c of contacts) {
    for (const t of (Array.isArray(c.tasks_json) ? c.tasks_json : [])) {
      if (!t.done && t.due && t.due >= today && t.due <= rangeEnd) items.push(`• Task: ${t.content} — ${c.name} (${t.due})`);
    }
  }
  if (items.length === 0) return "Nothing on the calendar for that range.";
  return items.slice(0, 15).join('\n');
}

async function handleTelegramIntent(intent, userId, contacts, rawText) {
  switch (intent.intent) {
    case 'log_interaction': {
      const matches = matchContacts(contacts, intent.contact_name);
      if (matches.length === 0) return `I couldn't find a contact matching "${intent.contact_name}".`;
      if (matches.length > 1) return `Multiple contacts match "${intent.contact_name}": ${matches.map(m => m.name).join(', ')}. Be more specific.`;
      const c = matches[0];
      const note = intent.note || rawText;
      const interactions = Array.isArray(c.interactions) ? c.interactions : [];
      interactions.push({ id: crypto.randomUUID(), content: note, date: new Date().toISOString().slice(0, 10), createdAt: new Date().toISOString() });
      await sbPatch(`contacts?id=eq.${encodeURIComponent(c.id)}&user_id=eq.${userId}`, { interactions, last_contact: new Date().toISOString().slice(0, 10), last_note: note });
      return `Logged for ${c.name}: "${note}"`;
    }
    case 'update_field': {
      const allowed = ['last_note', 'role', 'intention'];
      if (!allowed.includes(intent.field)) return `I can only update note, role, or intention via Telegram.`;
      const matches = matchContacts(contacts, intent.contact_name);
      if (matches.length === 0) return `I couldn't find a contact matching "${intent.contact_name}".`;
      if (matches.length > 1) return `Multiple contacts match "${intent.contact_name}": ${matches.map(m => m.name).join(', ')}.`;
      const c = matches[0];
      await sbPatch(`contacts?id=eq.${encodeURIComponent(c.id)}&user_id=eq.${userId}`, { [intent.field]: intent.value });
      return `Updated ${intent.field} for ${c.name}.`;
    }
    case 'query_contact': {
      const matches = matchContacts(contacts, intent.contact_name);
      if (matches.length === 0) return `I couldn't find a contact matching "${intent.contact_name}".`;
      if (matches.length > 1) return `Multiple contacts match: ${matches.map(m => m.name).join(', ')}.`;
      return summarizeContact(matches[0]);
    }
    case 'query_list':
      return summarizeList(contacts, intent.filter);
    case 'create_task': {
      const matches = matchContacts(contacts, intent.contact_name);
      if (matches.length === 0) return `I couldn't find a contact matching "${intent.contact_name}" — tasks need a contact.`;
      if (matches.length > 1) return `Multiple contacts match: ${matches.map(m => m.name).join(', ')}.`;
      const c = matches[0];
      const tasks = Array.isArray(c.tasks_json) ? c.tasks_json : [];
      const content = intent.task_content || rawText;
      tasks.push({ id: crypto.randomUUID(), content, due: intent.due_date || null, dueTime: null, done: false, important: false, createdAt: new Date().toISOString() });
      await sbPatch(`contacts?id=eq.${encodeURIComponent(c.id)}&user_id=eq.${userId}`, { tasks_json: tasks });
      return `Task added for ${c.name}: "${content}"${intent.due_date ? ` (due ${intent.due_date})` : ''}`;
    }
    case 'query_tasks':
      return summarizeTasks(contacts, intent.filter);
    case 'query_calendar':
      return summarizeCalendar(contacts, intent.filter);
    default:
      return `I didn't quite catch that. Try things like "had a call with Ahmad today" or "what's due this week".`;
  }
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'The Relationship Engine API' });
});

// Two shapes, because both live callers send the single-contact one:
//   { name, role, bio, notes, ... }  → { suggestion: "..." }   (dashboard + detail panel)
//   { contacts, goal }               → { suggestions: [...] }  (legacy batch form)
// The single-contact shape used to fall through to a 400 asking for `contacts and
// goal`, which meant every AI Outreach Suggestion in the app silently failed.
app.post('/api/suggest', async (req, res) => {
  try {
    const { contacts, goal } = req.body || {};

    if (Array.isArray(contacts) && goal) {
      const prompt = `You are a relationship intelligence assistant for founders using the TAG Framework (Trust, Authority, Generosity).\n\nThe user's goal: "${goal}"\n\nHere are their contacts:\n${JSON.stringify(contacts, null, 2)}\n\nBased on the goal and the contacts' tiers, tags, last interaction dates, and relationship strength, suggest the TOP 3 most relevant contacts to reach out to.\n\nFor each contact provide: name, reason, suggestion. Format as JSON array.`;
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: GROQ_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.7, max_tokens: 1000 })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(`Groq failed: HTTP ${response.status} ${JSON.stringify(data).slice(0, 300)}`);
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error(`Groq returned no content: ${JSON.stringify(data).slice(0, 300)}`);
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      return res.json({ suggestions: jsonMatch ? JSON.parse(jsonMatch[0]) : [] });
    }

    const c = req.body || {};
    if (!c.name) return res.status(400).json({ error: 'name (single contact) or contacts+goal is required' });

    // `bio` is the standing "who they are" summary, often read from their LinkedIn
    // profile. It's the difference between a generic nudge and an opener that
    // references what the person actually does.
    const prompt = `You are a relationship intelligence assistant for founders using the TAG Framework (Trust, Authority, Generosity).

Here is one contact:
${JSON.stringify(c, null, 2)}

Write a single short outreach suggestion — 2 to 3 sentences, addressed to the user (not to the contact) — telling them why to reach out now and what specifically to open with.

Ground it in this contact's actual details: who they are, their recent notes, achievements, interactions, and how long it has been. Be concrete. Never invent facts that are not present above. Do not use headings, bullet points or a greeting — just the suggestion itself.

Refer to the contact by name or as "they"/"them". A name does not tell you someone's gender — never infer pronouns from it. Use "he" or "she" only if the data above explicitly states the person's pronouns or gender.`;
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      // Same reasoning-token trap as summarizeProfile: the suggestion itself is
      // ~100 tokens, but reasoning is spent from this budget first, and running
      // out here returns an empty completion rather than an error.
      body: JSON.stringify({ model: GROQ_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.6, max_tokens: 2000, reasoning_effort: 'low' })
    });
    const data = await response.json();
    // Keep the body: a deprecated model reported model_not_found here and the old
    // generic message hid it completely.
    if (!response.ok) throw new Error(`Groq failed: HTTP ${response.status} ${JSON.stringify(data).slice(0, 300)}`);
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error(`Groq returned no content: ${JSON.stringify(data).slice(0, 300)}`);
    res.json({ suggestion: content.trim() });
  } catch (err) {
    console.error('Error in /api/suggest:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ── LinkedIn enrichment (Apify → Groq) ────────────────────────────────────────
// Always use supabase.auth.getUser(). Never hardcode user IDs.
//
// Cost is the governing design constraint: the Apify actor bills per profile
// fetched, so every path here is arranged to avoid a fetch it doesn't need.
//   - the URL must parse as a real /in/ profile before anything is called
//   - a cached result for the same URL returns without touching Apify at all
//   - maxItems is pinned to 1 so a bad input can never fan out into a bulk run
//   - the caller passes a contactId, never a URL, so this can't be used as an
//     open scraping proxy running on someone else's Apify credit
// Bulk import deliberately never calls this — 892 contacts in one paste would
// burn a month of credit in a single click.
const APIFY_TOKEN = process.env.APIFY_TOKEN;
// Overridable for the same reason as GROQ_MODEL: scraper actors get deprecated
// or repriced far faster than real APIs, and swapping one shouldn't need a deploy.
const APIFY_LINKEDIN_ACTOR = process.env.APIFY_LINKEDIN_ACTOR || 'harvestapi~linkedin-profile-scraper';
// The $4/1k tier. The email-search tier is $10/1k and we collect emails elsewhere.
const APIFY_SCRAPER_MODE = process.env.APIFY_SCRAPER_MODE || 'Profile details no email ($4 per 1k)';

// Accepts a bare handle, a bare domain path, or a full URL; returns the canonical
// profile URL, or null when the value isn't a personal profile at all. Company and
// school pages fall through to null on purpose — the actor can't read them and the
// call would be billed anyway.
function normalizeLinkedInUrl(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v) return null;
  const slug = /linkedin\.com/i.test(v)
    ? (v.match(/linkedin\.com\/in\/([^/?#\s]+)/i) || [])[1]
    : v.replace(/^\/+|\/+$/g, '');
  if (!slug) return null;
  let decoded;
  try { decoded = decodeURIComponent(slug); } catch { decoded = slug; }
  // LinkedIn slugs allow unicode — Arabic names are common in this network.
  if (!/^[\wÀ-￿-]{2,100}$/u.test(decoded)) return null;
  return `https://www.linkedin.com/in/${decoded.toLowerCase()}`;
}

async function fetchLinkedInProfile(profileUrl) {
  if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN is not set — add it in Railway → Variables');
  const endpoint = `https://api.apify.com/v2/acts/${APIFY_LINKEDIN_ACTOR}/run-sync-get-dataset-items`
    + `?token=${encodeURIComponent(APIFY_TOKEN)}&maxItems=1&timeout=120`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queries: [profileUrl], profileScraperMode: APIFY_SCRAPER_MODE, maxItems: 1 }),
    signal: AbortSignal.timeout(130000)
  });
  const body = await res.text();
  // Keep the response body in the error — swallowed causes have cost hours here before.
  if (!res.ok) throw new Error(`Apify actor ${APIFY_LINKEDIN_ACTOR} failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  let items;
  try {
    items = JSON.parse(body);
  } catch (err) {
    throw new Error(`Apify returned non-JSON (${err.message}): ${body.slice(0, 200)}`);
  }
  const profile = Array.isArray(items) ? items[0] : null;
  // A run that succeeds with zero items means the profile is private, renamed or
  // gone. That's a normal outcome, not a failure — the caller reports it as such.
  if (!profile || profile.error) return null;
  return profile;
}

// Turns the raw actor payload into the three things a relationship CRM actually
// wants: what they do, how to file them, and standing background on who they are.
// It deliberately does NOT write an outreach line — /api/suggest owns that, and
// it produces a better one from the bio than a scrape can produce on its own.
async function summarizeProfile(profile, contactName) {
  const trimmed = JSON.stringify(profile).slice(0, 12000);
  const prompt = `You are a relationship intelligence assistant using the TAG Framework (Trust, Authority, Generosity).

Below is scraped LinkedIn data for a contact named "${contactName}".

${trimmed}

Return ONLY a JSON object with exactly these keys:
{
  "role": "their current title at their current company, one short line, empty string if unclear",
  "tags": ["3-6 short lowercase topical tags: industry, function, location, notable affiliations"],
  "bio": "3-5 sentences describing who this person is: what they do now, what they have built or run, the shape of their career, and anything notable about their focus. Write it as standing background a founder would want to know before a conversation. Do NOT write an outreach message, do NOT address them in the second person, and do NOT suggest what to say to them."
}

Do not invent anything the data does not support. Use an empty string or empty array where data is missing.

Refer to the contact by name or as "they"/"them". A name does not tell you someone's gender — never infer pronouns from it. Use "he" or "she" only if the data above explicitly states the person's pronouns or gender.`;
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      // Reasoning tokens are billed against max_tokens BEFORE any output is
      // emitted, so a budget sized to the answer alone dies mid-document with
      // "max completion tokens reached before generating a valid document".
      // The JSON here is ~200 tokens; the rest is headroom for reasoning on a
      // dense profile. Low effort keeps that headroom from being spent.
      max_tokens: 3000,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' }
    }),
    signal: AbortSignal.timeout(45000)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Groq summarize failed: HTTP ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error(`Groq returned no content: ${JSON.stringify(data).slice(0, 300)}`);
  const parsed = JSON.parse(content);
  return {
    role: typeof parsed.role === 'string' ? parsed.role.trim() : '',
    tags: Array.isArray(parsed.tags)
      ? parsed.tags.filter(t => typeof t === 'string' && t.trim()).slice(0, 6).map(t => t.trim().toLowerCase())
      : [],
    bio: typeof parsed.bio === 'string' ? parsed.bio.trim() : ''
  };
}

// Returns a SUGGESTION. It deliberately does not write to the contact — scraped
// data is routinely months stale and must never silently overwrite something the
// user typed themselves. The frontend applies it only on explicit confirmation.
app.post('/api/enrich-linkedin', requireAuth, async (req, res) => {
  try {
    const { contactId, force } = req.body || {};
    if (!contactId || typeof contactId !== 'string') return res.status(400).json({ error: 'contactId is required' });

    // Scoped by user_id: the service key bypasses RLS, so this filter is the only
    // thing stopping one user from enriching — and billing against — another's contacts.
    const rows = await sbGet(`contacts?id=eq.${encodeURIComponent(contactId)}&user_id=eq.${req.userId}&select=id,name,linkedin`);
    const contact = rows?.[0];
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const url = normalizeLinkedInUrl(contact.linkedin);
    if (!url) return res.status(400).json({ error: 'This contact has no usable LinkedIn profile URL', code: 'no_url' });

    const cachedRows = await sbGet(`contact_enrichments?user_id=eq.${req.userId}&contact_id=eq.${encodeURIComponent(contactId)}&select=*`);
    const cached = cachedRows?.[0];
    // The point of the cache: same URL, already fetched, costs nothing to serve again.
    // Entries from before the bio/note rename hold second-person outreach text, which
    // would read as nonsense in a "who they are" field — those re-fetch once.
    if (cached && cached.linkedin_url === url && cached.suggestion_json?.bio && !force) {
      return res.json({ suggestion: cached.suggestion_json, cached: true, fetchedAt: cached.fetched_at });
    }

    const profile = await fetchLinkedInProfile(url);
    if (!profile) return res.status(404).json({ error: 'No public data found for that profile', code: 'not_found' });

    const suggestion = await summarizeProfile(profile, contact.name);

    await sbUpsert('contact_enrichments', {
      user_id: req.userId,
      contact_id: contactId,
      linkedin_url: url,
      profile_json: profile,
      suggestion_json: suggestion,
      fetched_at: new Date().toISOString()
    }, 'user_id,contact_id');

    res.json({ suggestion, cached: false, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Error in /api/enrich-linkedin:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.post('/api/resend-webhook', async (req, res) => {
  try {
    const signature = req.headers['svix-signature'];
    const timestamp = req.headers['svix-timestamp'];
    const webhookId = req.headers['svix-id'];
    if (!signature || !timestamp || !webhookId) return res.status(400).json({ error: 'Missing webhook headers' });
    const body = req.body.toString();
    const signedContent = `${webhookId}.${timestamp}.${body}`;
    const secret = RESEND_WEBHOOK_SECRET.replace('whsec_', '');
    const secretBytes = Buffer.from(secret, 'base64');
    const hmac = crypto.createHmac('sha256', secretBytes);
    hmac.update(signedContent);
    const computedSignature = hmac.digest('base64');
    const signatures = signature.split(' ').map(s => s.replace('v1,', ''));
    const isValid = signatures.some(sig => sig === computedSignature);
    if (!isValid) return res.status(401).json({ error: 'Invalid webhook signature' });
    const payload = JSON.parse(body);
    const email = payload?.data?.to?.[0];
    if (!email) return res.status(200).json({ message: 'No email found in payload' });
    await fetch(`https://api.resend.com/audiences/${RESEND_AUDIENCE_ID}/contacts`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_FULL_ACCESS_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, unsubscribed: false })
    });
    res.json({ success: true, email });
  } catch (err) {
    console.error('Error in /api/resend-webhook:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/invite-member', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing authorization token' });
    const token = authHeader.replace('Bearer ', '');
    const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_SERVICE_KEY }
    });
    if (!userResponse.ok) return res.status(401).json({ error: 'Invalid token' });
    const userData = await userResponse.json();
    const userId = userData.id;
    const roleResponse = await fetch(`${SUPABASE_URL}/rest/v1/org_members?user_id=eq.${userId}&select=role,org_id`, {
      headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_SERVICE_KEY }
    });
    const roleData = await roleResponse.json();
    const membership = roleData?.[0];
    if (membership?.role !== 'manager') return res.status(403).json({ error: 'Only managers can invite members' });
    const orgId = membership.org_id;
    const { email, role } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    const inviteRole = role === 'manager' ? 'manager' : 'member';
    await fetch(`${SUPABASE_URL}/rest/v1/team_invitations`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ email, org_id: orgId, role: inviteRole, invited_by: userId, status: 'pending' })
    });
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_FULL_ACCESS_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'The Relationship Engine <noreply@therelationshipengine.xyz>', to: [email], subject: "You've been invited to The Relationship Engine", html: '<p>You have been invited to join a team on The Relationship Engine.</p><p><a href="https://therelationshipengine.xyz">Accept Invitation</a></p>' })
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Error in /api/invite-member:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Always use supabase.auth.getUser(). Never hardcode user IDs.
app.post('/api/telegram/generate-code', requireAuth, async (req, res) => {
  try {
    const code = generateLinkingCode();
    const expires_at = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await sbPost('linking_codes', { code, user_id: req.userId, expires_at, used: false });
    res.json({ code, deepLink: `https://t.me/relationship_engine_bot?start=${code}` });
  } catch (err) {
    console.error('Error in /api/telegram/generate-code:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Always use supabase.auth.getUser(). Never hardcode user IDs.
app.get('/api/telegram/status', requireAuth, async (req, res) => {
  try {
    const rows = await sbGet(`telegram_links?user_id=eq.${req.userId}&status=eq.active&select=telegram_username&order=linked_at.desc&limit=1`);
    if (rows?.[0]) return res.json({ connected: true, username: rows[0].telegram_username || null });
    res.json({ connected: false, username: null });
  } catch (err) {
    console.error('Error in /api/telegram/status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Always use supabase.auth.getUser(). Never hardcode user IDs.
app.post('/api/telegram/disconnect', requireAuth, async (req, res) => {
  try {
    await sbPatch(`telegram_links?user_id=eq.${req.userId}&status=eq.active`, { status: 'revoked' });
    res.json({ success: true });
  } catch (err) {
    console.error('Error in /api/telegram/disconnect:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Public Telegram webhook. userId is ALWAYS resolved from telegram_links by telegram_chat_id —
// never from message text — and every contacts query below is scoped with .eq('user_id', userId)
// since the service role key bypasses RLS. Never remove these filters.
app.post('/api/telegram-webhook', async (req, res) => {
  let chatId;
  try {
    const message = req.body?.message;
    if (!message) return res.status(200).json({ ok: true });
    chatId = String(message.chat.id);
    const username = message.from?.username || null;
    const voice = message.voice || message.audio || null;
    let text = (message.text || '').trim();
    if (!text && !voice) return res.status(200).json({ ok: true });

    if (text.startsWith('/start')) {
      const code = text.replace('/start', '').trim().toUpperCase();
      if (!code) {
        await sendTelegramMessage(chatId, "Send me your 6-character linking code from The Relationship Engine app (Settings → Connect Telegram) to get started.");
        return res.json({ ok: true });
      }
      const linked = await tryLinkTelegram(code, chatId, username);
      await sendTelegramMessage(chatId, linked
        ? `You're connected! Send me things like "had a call with Ahmad today" or "note for Sarah: launching next month" and I'll log them. You can also just send a voice note — I'll transcribe it.`
        : "That code is invalid or expired. Generate a new one in Settings.");
      return res.json({ ok: true });
    }

    const linkRows = await sbGet(`telegram_links?telegram_chat_id=eq.${encodeURIComponent(chatId)}&status=eq.active&select=user_id`);
    let userId = linkRows?.[0]?.user_id;

    // Not linked yet — if the message looks like a bare linking code (e.g. sent as a
    // follow-up to /start rather than combined with it, which Telegram only auto-combines
    // on a brand-new chat), try it as a linking attempt before giving up.
    if (!userId && text && /^[A-Z2-9]{6}$/.test(text.toUpperCase())) {
      const linked = await tryLinkTelegram(text.toUpperCase(), chatId, username);
      if (linked) {
        await sendTelegramMessage(chatId, `You're connected! Send me things like "had a call with Ahmad today" or "note for Sarah: launching next month" and I'll log them. You can also just send a voice note — I'll transcribe it.`);
        return res.json({ ok: true });
      }
    }

    if (!userId) {
      await sendTelegramMessage(chatId, "You're not linked yet. Go to Settings → Connect Telegram in the app to get a code.");
      return res.json({ ok: true });
    }

    // A voice note becomes text, then follows exactly the same path as a typed message.
    let transcript = null;
    if (voice) {
      await sendTelegramAction(chatId, 'typing');
      try {
        transcript = await transcribeTelegramVoice(voice);
      } catch (err) {
        console.error('Voice transcription failed:', err);
        await sendTelegramMessage(chatId, "I couldn't make out that voice note — try again, or type it instead.");
        return res.json({ ok: true });
      }
      if (!transcript) {
        await sendTelegramMessage(chatId, "That voice note came through empty — mind sending it again?");
        return res.json({ ok: true });
      }
      text = transcript;
    }

    const contacts = await sbGet(`contacts?user_id=eq.${userId}&archived=eq.false&select=id,name,role,tier,last_contact,last_note,intention,interactions,tasks_json,birthday,cadence_days`);
    const intent = await classifyTelegramIntent(text, contacts);
    const reply = await handleTelegramIntent(intent, userId, contacts, text);
    // Echo what was heard, so a mis-transcription is obvious rather than silently logged.
    await sendTelegramMessage(chatId, transcript ? `🎤 "${transcript}"\n\n${reply}` : reply);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error in /api/telegram-webhook:', err);
    if (chatId) await sendTelegramMessage(chatId, "Something went wrong on my end — try again in a moment.").catch(() => {});
    res.status(200).json({ ok: true }); // 200 so Telegram doesn't retry indefinitely
  }
});

// ── Self-monitoring ───────────────────────────────────────────────────────────
// Every dependency here has silently broken in production at least once with no
// visible signal: the Groq model was deprecated out from under us, the API's custom
// domain came unbound from its Railway service, and the Telegram webhook pointed at a
// dead host. Each check exercises the real dependency rather than trusting config.
const HEALTH_INTERVAL_MS = 30 * 60 * 1000;
const ALERT_REPEAT_MS = 6 * 60 * 60 * 1000;
let health = { ok: null, checkedAt: null, failures: [] };
let lastAlertAt = 0;

async function runHealthChecks() {
  const failures = [];

  for (const [label, url] of [['Public API URL', `${API_URL}/`], ['Frontend', `${FRONTEND_URL}/`]]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) failures.push(`${label} (${url}) returned HTTP ${r.status}`);
    } catch (err) {
      failures.push(`${label} (${url}) unreachable: ${err.message}`);
    }
  }

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      // Reasoning models spend tokens before emitting content, so give the probe real
      // headroom — a starved budget looks identical to an outage otherwise.
      body: JSON.stringify({ model: GROQ_MODEL, messages: [{ role: 'user', content: 'Reply with the word OK.' }], max_tokens: 512 }),
      signal: AbortSignal.timeout(30000)
    });
    const d = await r.json();
    if (!r.ok) failures.push(`Groq model "${GROQ_MODEL}" failed: HTTP ${r.status} ${JSON.stringify(d?.error ?? d).slice(0, 200)}`);
    else if (!d.choices?.length) failures.push(`Groq model "${GROQ_MODEL}" returned no choices: ${JSON.stringify(d).slice(0, 200)}`);
  } catch (err) {
    failures.push(`Groq unreachable: ${err.message}`);
  }

  // The transcription model can't be exercised without an audio file, so check the
  // catalogue instead — a disappeared model is exactly how the chat model broke.
  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      signal: AbortSignal.timeout(15000)
    });
    const d = await r.json();
    if (!r.ok) failures.push(`Groq model catalogue unreadable: HTTP ${r.status}`);
    else {
      const ids = (d.data ?? []).map(m => m.id);
      if (!ids.includes(GROQ_TRANSCRIBE_MODEL)) {
        failures.push(`Transcription model "${GROQ_TRANSCRIBE_MODEL}" is no longer in Groq's catalogue — voice notes will fail`);
      }
    }
  } catch (err) {
    failures.push(`Groq model catalogue check failed: ${err.message}`);
  }

  try {
    await sbGet('contacts?select=id&limit=1');
  } catch (err) {
    failures.push(`Supabase query failed: ${err.message.slice(0, 200)}`);
  }

  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo`, { signal: AbortSignal.timeout(15000) });
    const d = await r.json();
    const registered = d?.result?.url;
    if (registered !== TELEGRAM_WEBHOOK_URL) failures.push(`Telegram webhook is "${registered || 'unset'}", expected "${TELEGRAM_WEBHOOK_URL}"`);
    if (d?.result?.last_error_message) failures.push(`Telegram webhook delivery error: ${d.result.last_error_message}`);
  } catch (err) {
    failures.push(`Telegram webhook check failed: ${err.message}`);
  }

  return failures;
}

async function sendEmail({ to, subject, html, text, headers }) {
  if (!RESEND_FULL_ACCESS_KEY) throw new Error('RESEND_FULL_ACCESS_KEY is not set');
  const payload = { from: EMAIL_FROM, reply_to: EMAIL_REPLY_TO, to: [to], subject, html };
  if (text) payload.text = text;
  if (headers) payload.headers = headers;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_FULL_ACCESS_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(`Resend send failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function sendAlertEmail(subject, html) {
  try {
    await sendEmail({ to: ALERT_EMAIL, subject, html });
  } catch (err) {
    console.error('Health alert email failed:', err.message);
  }
}

async function healthTick() {
  try {
    const failures = await runHealthChecks();
    const wasOk = health.ok;
    health = { ok: failures.length === 0, checkedAt: new Date().toISOString(), failures };

    if (failures.length > 0) {
      // Alert on the transition into failure, then at most once every ALERT_REPEAT_MS
      // while it stays broken, so an ongoing outage doesn't bury the inbox.
      const isNew = wasOk !== false;
      if (isNew || Date.now() - lastAlertAt > ALERT_REPEAT_MS) {
        lastAlertAt = Date.now();
        await sendAlertEmail(
          'The Relationship Engine — health check failed',
          `<p>The following checks are failing:</p><ul>${failures.map(f => `<li>${f}</li>`).join('')}</ul><p>Checked at ${health.checkedAt}</p>`
        );
      }
    } else if (wasOk === false) {
      lastAlertAt = 0;
      await sendAlertEmail(
        'The Relationship Engine — recovered',
        `<p>All health checks are passing again as of ${health.checkedAt}.</p>`
      );
    }
  } catch (err) {
    console.error('Health check tick failed:', err);
  }
}

app.get('/api/health', (req, res) => {
  res.status(health.ok === false ? 503 : 200).json(health);
});

// ── Weekly digest ─────────────────────────────────────────────────────────────
// Surfaces relationships going cold. The status rules below intentionally mirror
// src/utils.ts (contactStatus / getContactCadence) — if the app and the digest
// disagree about who's overdue, the digest is worse than useless.
const DIGEST_DAY = Number(process.env.DIGEST_DAY ?? 1); // 0=Sun, 1=Mon
const DIGEST_HOUR_UTC = Number(process.env.DIGEST_HOUR_UTC ?? 6);
const DIGEST_TICK_MS = 60 * 60 * 1000;
const TIER_CADENCE = { close: 14, wider: 45, general: 180 };
const TIER_RANK = { close: 0, wider: 1, general: 2 };
const TIER_LABEL = { close: 'Close', wider: 'Wider', general: 'General' };
const sentDigestsFallback = new Set(); // used only if digest_log is unavailable

function cadenceFor(c) {
  return c.cadence_days && c.cadence_days > 0 ? c.cadence_days : (TIER_CADENCE[c.tier] ?? TIER_CADENCE.general);
}
function daysSinceDate(d) {
  if (!d) return null;
  return Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
}
function contactState(c) {
  const d = daysSinceDate(c.last_contact);
  if (d === null) return 'never';
  const cad = cadenceFor(c);
  if (d > cad) return 'overdue';
  if (d > cad - 4) return 'due-soon';
  return 'good';
}
// Birthdays are stored as either YYYY-MM-DD or MM-DD — read the last two segments
// so both shapes work.
function birthdayDaysLeft(bday) {
  if (!bday) return null;
  const parts = String(bday).split('-').map(Number);
  if (parts.length < 2) return null;
  const m = parts[parts.length - 2];
  const d = parts[parts.length - 1];
  if (!m || !d || Number.isNaN(m) || Number.isNaN(d)) return null;
  const now = new Date();
  const b = new Date(now.getFullYear(), m - 1, d);
  if (b < now) b.setFullYear(now.getFullYear() + 1);
  return Math.ceil((b.getTime() - now.getTime()) / 86400000);
}
function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function buildDigest(contacts) {
  const overdue = [], dueSoon = [], never = [], birthdays = [], tasks = [];
  // Never-contacted splits in two: someone deliberately tiered close/wider and never
  // reached is a real signal, while a bulk-imported general contact is just an address
  // book entry. Nudging on the latter would bury the former in noise.
  const neverTiered = [];
  const today = new Date().toISOString().slice(0, 10);
  const weekEnd = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  for (const c of contacts) {
    const state = contactState(c);
    const d = daysSinceDate(c.last_contact);
    if (state === 'overdue') overdue.push({ ...c, daysOverdue: d - cadenceFor(c), days: d });
    else if (state === 'due-soon') dueSoon.push({ ...c, daysLeft: cadenceFor(c) - d });
    else if (state === 'never') {
      never.push(c);
      if (c.tier === 'close' || c.tier === 'wider') neverTiered.push(c);
    }

    const bd = birthdayDaysLeft(c.birthday);
    if (bd !== null && bd <= 14) birthdays.push({ name: c.name, days: bd });

    for (const t of (Array.isArray(c.tasks_json) ? c.tasks_json : [])) {
      if (!t.done && t.due && t.due <= weekEnd) {
        tasks.push({ content: t.content, due: t.due, contactName: c.name, isOverdue: t.due < today });
      }
    }
  }

  // Close relationships matter most, then by how far past cadence they are. Someone
  // with hundreds of stale general contacts should still see their close circle first.
  overdue.sort((a, b) => (TIER_RANK[a.tier] ?? 3) - (TIER_RANK[b.tier] ?? 3) || b.daysOverdue - a.daysOverdue);
  dueSoon.sort((a, b) => a.daysLeft - b.daysLeft);
  birthdays.sort((a, b) => a.days - b.days);
  tasks.sort((a, b) => a.due.localeCompare(b.due));
  neverTiered.sort((a, b) => (TIER_RANK[a.tier] ?? 3) - (TIER_RANK[b.tier] ?? 3) || String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));

  const untriaged = never.length - neverTiered.length;
  const hasContent = overdue.length + dueSoon.length + birthdays.length + tasks.length + neverTiered.length > 0;
  return { overdue, dueSoon, never, neverTiered, untriaged, birthdays, tasks, hasContent };
}

function renderDigestHtml(digest, contactCount) {
  const S = {
    wrap: 'max-width:560px;margin:0 auto;padding:32px 24px;font-family:Inter,-apple-system,Segoe UI,sans-serif;color:#0F172A;background:#ffffff;',
    h1: 'margin:0 0 4px;font-size:20px;font-weight:600;letter-spacing:-0.02em;color:#0F172A;',
    sub: 'margin:0 0 28px;font-size:13px;color:#64748B;',
    label: 'margin:28px 0 10px;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#64748B;',
    row: 'padding:10px 0;border-bottom:1px solid #E2E8F0;font-size:14px;',
    name: 'font-weight:600;color:#0F172A;',
    meta: 'color:#64748B;font-size:12px;',
    cta: 'display:inline-block;margin-top:28px;padding:10px 20px;background:#2563EB;color:#ffffff;text-decoration:none;border-radius:4px;font-size:14px;font-weight:500;',
    more: 'padding-top:10px;font-size:12px;color:#64748B;',
  };
  const section = (title, rows, extra) => rows.length === 0 ? '' :
    `<div style="${S.label}">${title}</div>${rows.join('')}${extra || ''}`;

  const parts = [];

  if (digest.overdue.length) {
    const shown = digest.overdue.slice(0, 8).map(c =>
      `<div style="${S.row}"><span style="${S.name}">${esc(c.name)}</span>` +
      `${c.role ? ` <span style="${S.meta}">· ${esc(c.role)}</span>` : ''}` +
      `<br><span style="${S.meta}">${c.days} days since contact · ${c.daysOverdue}d past your ${TIER_LABEL[c.tier] ?? ''} cadence</span></div>`
    );
    const rest = digest.overdue.length - shown.length;
    parts.push(section('Going cold', shown, rest > 0 ? `<div style="${S.more}">+ ${rest} more overdue</div>` : ''));
  }

  if (digest.dueSoon.length) {
    const shown = digest.dueSoon.slice(0, 5).map(c =>
      `<div style="${S.row}"><span style="${S.name}">${esc(c.name)}</span>` +
      `<br><span style="${S.meta}">due in ${c.daysLeft} day${c.daysLeft === 1 ? '' : 's'}</span></div>`
    );
    parts.push(section('Coming up', shown));
  }

  if (digest.neverTiered.length) {
    const shown = digest.neverTiered.slice(0, 5).map(c =>
      `<div style="${S.row}"><span style="${S.name}">${esc(c.name)}</span>` +
      `${c.role ? ` <span style="${S.meta}">· ${esc(c.role)}</span>` : ''}` +
      `<br><span style="${S.meta}">in your ${TIER_LABEL[c.tier] ?? ''} circle, never contacted</span></div>`
    );
    const rest = digest.neverTiered.length - shown.length;
    parts.push(section('Never reached out', shown, rest > 0 ? `<div style="${S.more}">+ ${rest} more</div>` : ''));
  }

  if (digest.birthdays.length) {
    const shown = digest.birthdays.slice(0, 5).map(b =>
      `<div style="${S.row}"><span style="${S.name}">${esc(b.name)}</span>` +
      `<br><span style="${S.meta}">${b.days === 0 ? 'birthday today' : `birthday in ${b.days} day${b.days === 1 ? '' : 's'}`}</span></div>`
    );
    parts.push(section('Birthdays', shown));
  }

  if (digest.tasks.length) {
    const shown = digest.tasks.slice(0, 8).map(t =>
      `<div style="${S.row}"><span style="${S.name}">${esc(t.content)}</span>` +
      `<br><span style="${S.meta}">${esc(t.contactName)} · ${t.isOverdue ? 'overdue' : 'due'} ${t.due}</span></div>`
    );
    parts.push(section('Tasks this week', shown));
  }

  if (!parts.length) {
    parts.push(`<div style="${S.row}">Nothing needs attention this week — every relationship is within its cadence.</div>`);
  }

  const headline = digest.overdue.length
    ? `${digest.overdue.length} relationship${digest.overdue.length === 1 ? '' : 's'} need${digest.overdue.length === 1 ? 's' : ''} attention`
    : 'Your week ahead';

  // Untriaged contacts are the real blocker when they dominate: the cadence engine
  // can't track anyone still sitting in the default general tier.
  const triageNote = digest.untriaged >= 25
    ? `<div style="${S.more}">${digest.untriaged} imported contacts are still untiered — sorting a few into Close or Wider lets them show up here.</div>`
    : '';

  return `<div style="${S.wrap}">` +
    `<h1 style="${S.h1}">${headline}</h1>` +
    `<p style="${S.sub}">Across ${contactCount} contact${contactCount === 1 ? '' : 's'}</p>` +
    parts.join('') +
    triageNote +
    `<a href="${FRONTEND_URL}" style="${S.cta}">Open The Relationship Engine</a>` +
    `</div>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

// A plain-text alternative isn't optional: HTML-only mail is a well-known spam
// signal, and this one was landing in spam without it.
function renderDigestText(digest, contactCount) {
  const lines = [];
  lines.push(digest.overdue.length
    ? `${digest.overdue.length} relationship${digest.overdue.length === 1 ? '' : 's'} need attention`
    : 'Your week ahead');
  lines.push(`Across ${contactCount} contact${contactCount === 1 ? '' : 's'}`);

  if (digest.overdue.length) {
    lines.push('', 'GOING COLD');
    for (const c of digest.overdue.slice(0, 8)) {
      lines.push(`- ${c.name}${c.role ? ` (${c.role})` : ''}: ${c.days} days since contact, ${c.daysOverdue}d past cadence`);
    }
    const rest = digest.overdue.length - Math.min(8, digest.overdue.length);
    if (rest > 0) lines.push(`  + ${rest} more overdue`);
  }
  if (digest.dueSoon.length) {
    lines.push('', 'COMING UP');
    for (const c of digest.dueSoon.slice(0, 5)) lines.push(`- ${c.name}: due in ${c.daysLeft} day${c.daysLeft === 1 ? '' : 's'}`);
  }
  if (digest.neverTiered.length) {
    lines.push('', 'NEVER REACHED OUT');
    for (const c of digest.neverTiered.slice(0, 5)) {
      lines.push(`- ${c.name}${c.role ? ` (${c.role})` : ''}: in your ${TIER_LABEL[c.tier] ?? ''} circle, never contacted`);
    }
    const rest = digest.neverTiered.length - Math.min(5, digest.neverTiered.length);
    if (rest > 0) lines.push(`  + ${rest} more`);
  }
  if (digest.birthdays.length) {
    lines.push('', 'BIRTHDAYS');
    for (const b of digest.birthdays.slice(0, 5)) lines.push(`- ${b.name}: ${b.days === 0 ? 'today' : `in ${b.days} day${b.days === 1 ? '' : 's'}`}`);
  }
  if (digest.tasks.length) {
    lines.push('', 'TASKS THIS WEEK');
    for (const t of digest.tasks.slice(0, 8)) lines.push(`- ${t.content} (${t.contactName}, ${t.isOverdue ? 'overdue' : 'due'} ${t.due})`);
  }
  if (!digest.hasContent) {
    lines.push('', 'Nothing needs attention this week - every relationship is within its cadence.');
  }
  if (digest.untriaged >= 25) {
    lines.push('', `${digest.untriaged} imported contacts are still untiered - sorting a few into Close or Wider lets them show up here.`);
  }
  lines.push('', `Open The Relationship Engine: ${FRONTEND_URL}`);
  return lines.join('\n');
}

// Always resolve contacts by the target user's own id — never a shared or default scope.
async function sendDigestForUser(userId, email, { force = false } = {}) {
  if (!email) return { sent: false, reason: 'no email' };
  const contacts = await sbGet(`contacts?user_id=eq.${userId}&archived=eq.false&select=id,name,role,tier,last_contact,birthday,cadence_days,tasks_json`);
  if (!contacts.length) return { sent: false, reason: 'no contacts' };

  const digest = buildDigest(contacts);
  if (!digest.hasContent && !force) return { sent: false, reason: 'nothing to report' };

  await sendEmail({
    to: email,
    subject: digest.overdue.length
      ? `${digest.overdue.length} relationship${digest.overdue.length === 1 ? '' : 's'} need attention this week`
      : 'Your relationships this week',
    html: renderDigestHtml(digest, contacts.length),
    text: renderDigestText(digest, contacts.length),
    // Recurring mail without an unsubscribe path gets penalised by Gmail and is
    // the wrong thing to send regardless.
    headers: {
      'List-Unsubscribe': `<mailto:${EMAIL_REPLY_TO}?subject=Unsubscribe%20from%20weekly%20digest>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });
  // If they've linked Telegram, deliver it there too — that's where the logging
  // habit already lives, and it's one tap from replying with an update.
  try {
    const links = await sbGet(`telegram_links?user_id=eq.${userId}&status=eq.active&select=telegram_chat_id&order=linked_at.desc&limit=1`);
    const chatId = links?.[0]?.telegram_chat_id;
    if (chatId) await sendTelegramMessage(chatId, renderDigestText(digest, contacts.length));
  } catch (err) {
    console.error(`Telegram digest delivery failed for ${userId}:`, err.message);
  }

  return { sent: true, counts: { overdue: digest.overdue.length, dueSoon: digest.dueSoon.length, birthdays: digest.birthdays.length, tasks: digest.tasks.length } };
}

async function listAuthUsers() {
  const users = [];
  for (let page = 1; page <= 20; page++) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=200`, {
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY }
    });
    if (!r.ok) throw new Error(`Supabase admin users failed: ${r.status} ${await r.text()}`);
    const d = await r.json();
    const batch = d.users ?? [];
    users.push(...batch);
    if (batch.length < 200) break;
  }
  return users;
}

async function digestAlreadySent(userId, weekKey) {
  try {
    const rows = await sbGet(`digest_log?user_id=eq.${userId}&week_key=eq.${encodeURIComponent(weekKey)}&select=user_id`);
    return rows.length > 0;
  } catch (err) {
    console.error('digest_log read failed, falling back to in-memory dedupe:', err.message);
    return sentDigestsFallback.has(`${userId}:${weekKey}`);
  }
}

async function markDigestSent(userId, weekKey) {
  sentDigestsFallback.add(`${userId}:${weekKey}`);
  try {
    await sbPost('digest_log', { user_id: userId, week_key: weekKey });
  } catch (err) {
    console.error('digest_log write failed (dedupe is in-memory only this run):', err.message);
  }
}

async function digestTick() {
  try {
    const now = new Date();
    if (now.getUTCDay() !== DIGEST_DAY || now.getUTCHours() !== DIGEST_HOUR_UTC) return;
    const weekKey = isoWeekKey(now);
    const users = await listAuthUsers();
    console.log(`Digest run ${weekKey}: ${users.length} users`);
    for (const u of users) {
      try {
        if (await digestAlreadySent(u.id, weekKey)) continue;
        const result = await sendDigestForUser(u.id, u.email);
        // Mark regardless of whether an email went out, so users with nothing to
        // report aren't re-evaluated every hour of the send window.
        await markDigestSent(u.id, weekKey);
        if (result.sent) console.log(`Digest sent to ${u.id}`);
      } catch (err) {
        console.error(`Digest failed for user ${u.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Digest tick failed:', err);
  }
}

// Always use supabase.auth.getUser(). Never hardcode user IDs.
app.post('/api/digest/send-me', requireAuth, async (req, res) => {
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${req.userId}`, {
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY }
    });
    if (!r.ok) return res.status(500).json({ error: 'Could not resolve your account email' });
    const user = await r.json();
    const result = await sendDigestForUser(req.userId, user.email, { force: true });
    if (!result.sent) return res.status(400).json({ error: result.reason === 'no contacts' ? 'You have no contacts yet.' : 'Nothing to send.' });
    res.json({ success: true, sentTo: user.email, ...result });
  } catch (err) {
    console.error('Error in /api/digest/send-me:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`RE API running on port ${PORT}`);
    setTimeout(healthTick, 60 * 1000).unref?.();
    setInterval(healthTick, HEALTH_INTERVAL_MS);
    setInterval(digestTick, DIGEST_TICK_MS);
  });
}

module.exports = { buildDigest, renderDigestHtml, renderDigestText, contactState, cadenceFor, birthdayDaysLeft, isoWeekKey };