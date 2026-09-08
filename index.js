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

async function sendTelegramMessage(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
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
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: 300 })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Groq classify failed: ${response.status} ${JSON.stringify(data)}`);
  const content = data.choices?.[0]?.message?.content || '{}';
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  try {
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

// TEMP debug route — lists available Groq model IDs. Remove once the model is fixed.
app.get('/api/debug/groq-models', async (req, res) => {
  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${GROQ_API_KEY}` } });
    const d = await r.json();
    res.status(r.status).json({ status: r.status, ids: d.data?.map(m => m.id) ?? d });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'The Relationship Engine API' });
});

app.post('/api/suggest', async (req, res) => {
  try {
    const { contacts, goal } = req.body;
    if (!contacts || !goal) return res.status(400).json({ error: 'contacts and goal are required' });
    const prompt = `You are a relationship intelligence assistant for founders using the TAG Framework (Trust, Authority, Generosity).\n\nThe user's goal: "${goal}"\n\nHere are their contacts:\n${JSON.stringify(contacts, null, 2)}\n\nBased on the goal and the contacts' tiers, tags, last interaction dates, and relationship strength, suggest the TOP 3 most relevant contacts to reach out to.\n\nFor each contact provide: name, reason, suggestion. Format as JSON array.`;
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], temperature: 0.7, max_tokens: 1000 })
    });
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return res.status(500).json({ error: 'No response from AI', debug: { status: response.status, data } });
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    const suggestions = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    res.json({ suggestions });
  } catch (err) {
    console.error('Error in /api/suggest:', err);
    res.status(500).json({ error: 'Internal server error' });
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
    if (!message?.text) return res.status(200).json({ ok: true });
    chatId = String(message.chat.id);
    const text = message.text.trim();
    const username = message.from?.username || null;

    if (text.startsWith('/start')) {
      const code = text.replace('/start', '').trim().toUpperCase();
      if (!code) {
        await sendTelegramMessage(chatId, "Send me your 6-character linking code from The Relationship Engine app (Settings → Connect Telegram) to get started.");
        return res.json({ ok: true });
      }
      const linked = await tryLinkTelegram(code, chatId, username);
      await sendTelegramMessage(chatId, linked
        ? `You're connected! Send me things like "had a call with Ahmad today" or "note for Sarah: launching next month" and I'll log them.`
        : "That code is invalid or expired. Generate a new one in Settings.");
      return res.json({ ok: true });
    }

    const linkRows = await sbGet(`telegram_links?telegram_chat_id=eq.${encodeURIComponent(chatId)}&status=eq.active&select=user_id`);
    let userId = linkRows?.[0]?.user_id;

    // Not linked yet — if the message looks like a bare linking code (e.g. sent as a
    // follow-up to /start rather than combined with it, which Telegram only auto-combines
    // on a brand-new chat), try it as a linking attempt before giving up.
    if (!userId && /^[A-Z2-9]{6}$/.test(text.toUpperCase())) {
      const linked = await tryLinkTelegram(text.toUpperCase(), chatId, username);
      if (linked) {
        await sendTelegramMessage(chatId, `You're connected! Send me things like "had a call with Ahmad today" or "note for Sarah: launching next month" and I'll log them.`);
        return res.json({ ok: true });
      }
    }

    if (!userId) {
      await sendTelegramMessage(chatId, "You're not linked yet. Go to Settings → Connect Telegram in the app to get a code.");
      return res.json({ ok: true });
    }

    const contacts = await sbGet(`contacts?user_id=eq.${userId}&archived=eq.false&select=id,name,role,tier,last_contact,last_note,intention,interactions,tasks_json,birthday,cadence_days`);
    const intent = await classifyTelegramIntent(text, contacts);
    const reply = await handleTelegramIntent(intent, userId, contacts, text);
    await sendTelegramMessage(chatId, reply);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error in /api/telegram-webhook:', err);
    if (chatId) await sendTelegramMessage(chatId, `[debug] ${err.message}`).catch(() => {});
    res.status(200).json({ ok: true, debug: String(err?.message || err) }); // 200 so Telegram doesn't retry indefinitely
  }
});

app.listen(PORT, () => console.log(`RE API running on port ${PORT}`));