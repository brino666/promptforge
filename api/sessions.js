// api/sessions.js
// Thais -- Forge Session Archive
// Stores complete Forge prompt + response pairs as retrievable work artifacts.
// Separate from the memory system -- sessions are documents, not facts.
// Memory gets a brief summary reference; the full content lives here.

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
    'Prefer': 'return=representation',
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

// Validate session token -- same pattern as memories.js
async function validateSession(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  try {
    const res = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + token,
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.id || null;
  } catch (err) {
    return null;
  }
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const userId = await validateSession(authHeader);

  if (!userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // GET -- fetch sessions list or single session
  if (req.method === 'GET') {
    const { id, starred } = req.query || {};

    // Single session fetch by ID
    if (id) {
      try {
        const sessions = await sbFetch(
          '/sessions?id=eq.' + encodeURIComponent(id) +
          '&user_id=eq.' + encodeURIComponent(userId) +
          '&limit=1'
        );
        if (!sessions || sessions.length === 0) {
          return res.status(404).json({ error: 'Session not found' });
        }
        return res.status(200).json({ session: sessions[0] });
      } catch (err) {
        console.error('[sessions GET single] error:', err.message);
        return res.status(500).json({ error: 'Failed to fetch session' });
      }
    }

    // List sessions -- starred first, then by recency
    try {
      const filter = starred === 'true'
        ? '&starred=eq.true'
        : '';
      const sessions = await sbFetch(
        '/sessions?user_id=eq.' + encodeURIComponent(userId) +
        filter +
        '&order=starred.desc,created_at.desc' +
        '&limit=100'
      );
      return res.status(200).json({ sessions: sessions || [] });
    } catch (err) {
      console.error('[sessions GET list] error:', err.message);
      return res.status(500).json({ error: 'Failed to fetch sessions' });
    }
  }

  // POST -- create a new session
  if (req.method === 'POST') {
    const { forge_prompt, response, title, summary, origin } = req.body || {};

    if (!forge_prompt || !response) {
      return res.status(400).json({ error: 'forge_prompt and response are required' });
    }

    try {
      const inserted = await sbFetch('/sessions', {
        method: 'POST',
        body: JSON.stringify({
          user_id: userId,
          title: title || null,
          forge_prompt: forge_prompt,
          response: response,
          summary: summary || null,
          origin: origin || 'forge',
          starred: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      });
      return res.status(200).json({ session: inserted[0] || null });
    } catch (err) {
      console.error('[sessions POST] error:', err.message);
      return res.status(500).json({ error: 'Failed to create session' });
    }
  }

  // PATCH -- update title, summary, or starred status
  if (req.method === 'PATCH') {
    const { id, title, summary, starred } = req.body || {};

    if (!id) return res.status(400).json({ error: 'Session ID required' });

    // Confirm ownership before updating
    try {
      const existing = await sbFetch(
        '/sessions?id=eq.' + encodeURIComponent(id) +
        '&user_id=eq.' + encodeURIComponent(userId) +
        '&limit=1'
      );
      if (!existing || existing.length === 0) {
        return res.status(404).json({ error: 'Session not found or not yours' });
      }

      const updates = { updated_at: new Date().toISOString() };
      if (title !== undefined) updates.title = title;
      if (summary !== undefined) updates.summary = summary;
      if (starred !== undefined) updates.starred = starred;

      await sbFetch('/sessions?id=eq.' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify(updates),
      });

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('[sessions PATCH] error:', err.message);
      return res.status(500).json({ error: 'Failed to update session' });
    }
  }

  // DELETE -- remove a session permanently
  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Session ID required' });

    try {
      const existing = await sbFetch(
        '/sessions?id=eq.' + encodeURIComponent(id) +
        '&user_id=eq.' + encodeURIComponent(userId) +
        '&limit=1'
      );
      if (!existing || existing.length === 0) {
        return res.status(404).json({ error: 'Session not found or not yours' });
      }

      await sbFetch('/sessions?id=eq.' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: { 'Prefer': 'return=minimal' },
      });

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('[sessions DELETE] error:', err.message);
      return res.status(500).json({ error: 'Failed to delete session' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
