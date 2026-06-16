// api/memories.js
// Thais — Secure memory fetch endpoint
// Replaces direct Supabase client calls from the frontend memory panel.
// Uses service role key server-side so RLS policies on the client don't block reads.
// Validates userId against the authenticated session to prevent spoofing.

import Anthropic from '@anthropic-ai/sdk';

const SUPABASE_URL = process.env.supabase_url || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.supabase_ret_key || process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.supabase_anon_key;

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

// Validate the user's JWT token to confirm their identity
// This prevents a logged-in user from passing someone else's userId
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
  if (req.method === 'GET') {
    // Fetch memories for the authenticated user
    const authHeader = req.headers.authorization;
    const authenticatedUserId = await validateSession(authHeader);

    if (!authenticatedUserId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
      const memories = await sbFetch(
        '/memories?user_id=eq.' + encodeURIComponent(authenticatedUserId) +
        '&superseded=eq.false' +
        '&order=anchor.desc,updated_at.desc' +
        '&limit=100'
      );

      return res.status(200).json({ memories });
    } catch (err) {
      console.error('[memories GET] error:', err.message);
      return res.status(500).json({ error: 'Failed to load memories' });
    }
  }

  if (req.method === 'DELETE') {
    // Delete a specific memory, validating ownership first
    const authHeader = req.headers.authorization;
    const authenticatedUserId = await validateSession(authHeader);

    if (!authenticatedUserId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Memory ID required' });

    try {
      // Confirm this memory belongs to the authenticated user before deleting
      const existing = await sbFetch(
        '/memories?id=eq.' + encodeURIComponent(id) +
        '&user_id=eq.' + encodeURIComponent(authenticatedUserId) +
        '&limit=1'
      );

      if (!existing || existing.length === 0) {
        return res.status(404).json({ error: 'Memory not found or not yours' });
      }

      await sbFetch('/memories?id=eq.' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: { 'Prefer': 'return=minimal' },
      });

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('[memories DELETE] error:', err.message);
      return res.status(500).json({ error: 'Failed to delete memory' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
