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
const PORT = process.env.PORT || 3001;

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
    if (!content) return res.status(500).json({ error: 'No response from AI' });
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
    const roleResponse = await fetch(`${SUPABASE_URL}/rest/v1/org_members?user_id=eq.${userId}&select=role`, {
      headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_SERVICE_KEY }
    });
    const roleData = await roleResponse.json();
    if (roleData?.[0]?.role !== 'manager') return res.status(403).json({ error: 'Only managers can invite members' });
    const { email, orgId } = req.body;
    if (!email || !orgId) return res.status(400).json({ error: 'email and orgId are required' });
    await fetch(`${SUPABASE_URL}/rest/v1/team_invitations`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ email, org_id: orgId, invited_by: userId, status: 'pending' })
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

app.listen(PORT, () => console.log(`RE API running on port ${PORT}`));