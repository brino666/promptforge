// api/diagnostics.js
// Thais -- Memory Stats Endpoint
// REFACTOR: Now a pure stats gatherer only. Claude call moved to chat.js
// so diagnostics run through Thais's full system prompt with memory context.
// This fixes the gap where Thais couldn't remember her own diagnostic responses.

const SUPABASE_URL = process.env.supabase_url || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.supabase_ret_key || process.env.SUPABASE_SERVICE_ROLE_KEY;

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
    Object.assign({}, options, { headers: headers })
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Supabase error: ' + err);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

export async function getMemoryStats(userId) {
  try {
    const memories = await sbFetch(
      '/memories?user_id=eq.' + encodeURIComponent(userId) +
      '&superseded=eq.false&order=updated_at.desc&limit=200'
    );

    if (!memories || memories.length === 0) {
      return { total: 0, categories: {}, confidence: {}, sources: {}, anchors: 0, recent: [] };
    }

    const stats = {
      total: memories.length,
      categories: {},
      confidence: { high: 0, medium: 0, low: 0 },
      sources: { stated: 0, inferred: 0 },
      anchors: 0,
      recent: [],
      oldest: null,
      newest: null,
    };

    const categoryOrder = ['personal', 'work', 'plan', 'idea', 'lore'];
    categoryOrder.forEach(function(c) { stats.categories[c] = 0; });

    memories.forEach(function(m) {
      if (stats.categories[m.category] !== undefined) stats.categories[m.category]++;
      if (stats.confidence[m.confidence] !== undefined) stats.confidence[m.confidence]++;
      if (m.source === 'stated') stats.sources.stated++;
      else stats.sources.inferred++;
      if (m.anchor) stats.anchors++;
    });

    // Most recent 5 for context
    stats.recent = memories.slice(0, 5).map(function(m) {
      return '[' + m.category + '/' + m.weight + '] ' + m.content;
    });

    const dates = memories.map(function(m) { return new Date(m.updated_at); });
    stats.oldest = new Date(Math.min.apply(null, dates)).toLocaleDateString();
    stats.newest = new Date(Math.max.apply(null, dates)).toLocaleDateString();

    return stats;
  } catch (err) {
    console.error('[diagnostics memory error]', err.message);
    return { total: 0, error: err.message };
  }
}

// HTTP handler kept for direct calls from the frontend dropdown
// but now just returns stats -- the Claude response is generated in chat.js
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body;
  const userId = body.userId || 'anonymous';

  if (userId === 'anonymous') {
    return res.status(200).json({
      stats: null,
      message: null,
    });
  }

  try {
    const stats = await getMemoryStats(userId);
    return res.status(200).json({ stats });
  } catch (error) {
    console.error('[diagnostics] error:', error.message);
    return res.status(500).json({ error: 'Diagnostic check failed.' });
  }
}
