// api/focus.js
// Thais's live model of what the user is currently focused on.
// Unlike memories (append-only facts), focus is a small rewritten state --
// at most 10 rows per user, updated each turn to reflect active threads.

const SUPABASE_URL = process.env.supabase_url || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.supabase_ret_key || process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  || process.env.supabase_anon_key
  || process.env.supabase_non_key;

async function sbFetch(path, options) {
  options = options || {};
  const headers = Object.assign({
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
    'Content-Type': 'application/json',
  }, options.headers || {});
  const res = await fetch(
    SUPABASE_URL + '/rest/v1' + path,
    Object.assign({}, options, { headers })
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Supabase error: ' + err);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function validateSession(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  try {
    const res = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.id || null;
  } catch { return null; }
}

export default async function handler(req, res) {
  const userId = await validateSession(req.headers.authorization);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  if (req.method === 'GET') {
    try {
      const rows = await sbFetch(
        '/focus?user_id=eq.' + encodeURIComponent(userId) +
        '&order=updated_at.desc&limit=10'
      );
      return res.status(200).json({ focus: rows });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to load focus' });
    }
  }

  // PUT — replace entire focus state (called by chat.js after each turn)
  if (req.method === 'PUT') {
    const { items } = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items array required' });
    try {
      // Delete existing focus for this user, then insert fresh state
      await sbFetch('/focus?user_id=eq.' + encodeURIComponent(userId), {
        method: 'DELETE',
        headers: { 'Prefer': 'return=minimal' },
      });
      if (items.length > 0) {
        const rows = items.slice(0, 10).map(function(item) {
          return {
            user_id: userId,
            topic: (item.topic || '').slice(0, 300),
            context: (item.context || '').slice(0, 500),
            intensity: ['high', 'medium', 'low'].includes(item.intensity) ? item.intensity : 'medium',
            updated_at: new Date().toISOString(),
          };
        });
        await sbFetch('/focus', {
          method: 'POST',
          headers: { 'Prefer': 'return=minimal' },
          body: JSON.stringify(rows),
        });
      }
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('[focus PUT]', err.message);
      return res.status(500).json({ error: 'Failed to update focus' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
