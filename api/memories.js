// api/memories.js
// Thais — Secure memory fetch + cleanup endpoint
// FIX: Added supabase_non_key fallback for Vercel typo
// FIX: Smarter memory prioritization (anchor > major > confidence > recency)
// NEW: /api/memories?action=cleanup for one-time dedup of existing memories

import { MODEL_FAST } from '../config/models.js';

const SUPABASE_URL = process.env.supabase_url || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.supabase_ret_key || process.env.SUPABASE_SERVICE_ROLE_KEY;

// FIX: catches the typo 'supabase_non_key' that exists in Vercel
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

// Validate the user's JWT token to confirm their identity
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

// Smart memory prioritization:
// 1. Anchors always first
// 2. Major weight over minor
// 3. High confidence over medium
// 4. Recent over old
// 5. Stated over inferred (more reliable)
function prioritizeMemories(memories, limit) {
  const score = function(m) {
    let s = 0;
    if (m.anchor) s += 1000;
    if (m.weight === 'major') s += 100;
    if (m.confidence === 'high') s += 20;
    if (m.confidence === 'medium') s += 10;
    if (m.source === 'stated') s += 5;
    if (m.source === 'synthesized') s += 15;
    // Recency bonus — memories updated in last 7 days get a boost
    const age = Date.now() - new Date(m.updated_at).getTime();
    const daysOld = age / (1000 * 60 * 60 * 24);
    if (daysOld < 7) s += 15;
    if (daysOld < 1) s += 10;
    // Occurrence bonus — things mentioned multiple times are more reliable
    s += Math.min((m.occurrences || 1) * 3, 15);
    return s;
  };

  return memories
    .slice()
    .sort(function(a, b) { return score(b) - score(a); })
    .slice(0, limit);
}

// One-time cleanup: find and mark duplicate memories as superseded
// Groups by category, compares content similarity, keeps the best version
async function cleanupDuplicates(userId) {
  const all = await sbFetch(
    '/memories?user_id=eq.' + encodeURIComponent(userId) +
    '&superseded=eq.false' +
    '&order=category.asc,updated_at.desc' +
    '&limit=500'
  );

  if (!all || all.length === 0) return { cleaned: 0, remaining: 0 };

  const toSupersede = [];
  const categories = ['personal', 'work', 'plan', 'idea', 'lore'];

  for (const cat of categories) {
    const items = all.filter(function(m) { return m.category === cat; });
    if (items.length < 2) continue;

    const seen = [];
    for (const item of items) {
      const itemLower = item.content.toLowerCase();
      // Check if this is too similar to something we've already kept
      const isDuplicate = seen.some(function(kept) {
        const keptLower = kept.content.toLowerCase();
        // Check for substring match either way
        if (itemLower.includes(keptLower.slice(0, 50))) return true;
        if (keptLower.includes(itemLower.slice(0, 50))) return true;
        // Check for high word overlap
        const itemWords = new Set(itemLower.split(/\s+/).filter(w => w.length > 4));
        const keptWords = new Set(keptLower.split(/\s+/).filter(w => w.length > 4));
        if (itemWords.size === 0) return false;
        let overlap = 0;
        itemWords.forEach(function(w) { if (keptWords.has(w)) overlap++; });
        const similarity = overlap / Math.max(itemWords.size, keptWords.size);
        return similarity > 0.6;
      });

      if (isDuplicate) {
        toSupersede.push(item.id);
      } else {
        seen.push(item);
      }
    }
  }

  // Mark duplicates as superseded in batches
  let cleaned = 0;
  for (const id of toSupersede) {
    try {
      await sbFetch('/memories?id=eq.' + id, {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({ superseded: true, updated_at: new Date().toISOString() }),
      });
      cleaned++;
    } catch (err) {
      console.error('[cleanup] failed to supersede', id, err.message);
    }
  }

  return {
    cleaned,
    remaining: all.length - cleaned,
    total: all.length,
  };
}

const COMPRESSION_SYSTEM_PROMPT = `You are a memory compression system for a personal AI assistant.
Synthesize a group of related memories into concise, high-value knowledge statements.

Rules:
- Combine redundant observations into single clear statements
- Preserve the most specific and useful details
- Discard vague or low-value generalizations
- Each output statement must be standalone and immediately useful
- Produce no more than 3 synthesized statements per group

Respond ONLY with valid JSON: { "statements": ["...", "..."] }`;

async function compressMemories(userId) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('No API key configured for compression');

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const candidates = await sbFetch(
    '/memories?user_id=eq.' + encodeURIComponent(userId) +
    '&anchor=eq.false' +
    '&superseded=eq.false' +
    '&updated_at=lt.' + thirtyDaysAgo +
    '&order=category.asc,confidence.asc' +
    '&limit=200'
  );

  if (!candidates || candidates.length < 5) {
    return { compressed: 0, synthesized: 0, message: 'Not enough old memories to compress yet' };
  }

  const grouped = {};
  for (const m of candidates) {
    if (!grouped[m.category]) grouped[m.category] = [];
    grouped[m.category].push(m);
  }

  let totalCompressed = 0;
  let totalSynthesized = 0;

  for (const [category, memories] of Object.entries(grouped)) {
    if (memories.length < 3) continue;

    for (let i = 0; i < memories.length; i += 10) {
      const batch = memories.slice(i, i + 10);
      if (batch.length < 2) continue;

      const memoryList = batch
        .map((m, idx) => `${idx + 1}. [${m.confidence}] ${m.content}`)
        .join('\n');

      try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: MODEL_FAST,
            max_tokens: 500,
            system: COMPRESSION_SYSTEM_PROMPT,
            messages: [{
              role: 'user',
              content: `Category: ${category}\n\nMemories:\n${memoryList}\n\nSynthesize into 1-3 high-value statements.`,
            }],
          }),
        });

        const data = await response.json();
        const text = data.content?.[0]?.text;
        if (!text) continue;

        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
        const statements = (parsed.statements || []).filter((s) => s && s.length > 10);

        for (const m of batch) {
          try {
            await sbFetch('/memories?id=eq.' + m.id, {
              method: 'PATCH',
              headers: { 'Prefer': 'return=minimal' },
              body: JSON.stringify({ superseded: true, updated_at: new Date().toISOString() }),
            });
            totalCompressed++;
          } catch (err) {
            console.error('[compress] failed to supersede', m.id, err.message);
          }
        }

        for (const stmt of statements.slice(0, 3)) {
          try {
            await sbFetch('/memories', {
              method: 'POST',
              body: JSON.stringify({
                user_id: userId,
                category,
                weight: 'major',
                content: stmt,
                source: 'synthesized',
                confidence: 'high',
                anchor: false,
                sequence: 0,
                occurrences: batch.length,
                superseded: false,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              }),
            });
            totalSynthesized++;
          } catch (err) {
            console.error('[compress] failed to store synthesis', err.message);
          }
        }
      } catch (err) {
        console.error('[compress] synthesis failed for category', category, err.message);
      }
    }
  }

  return {
    compressed: totalCompressed,
    synthesized: totalSynthesized,
    message: `Compressed ${totalCompressed} memories into ${totalSynthesized} synthesized insights`,
  };
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const authenticatedUserId = await validateSession(authHeader);

  if (!authenticatedUserId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // GET — fetch memories for the memory panel
  if (req.method === 'GET') {
    const action = req.query && req.query.action;

    if (action === 'compress') {
      try {
        const result = await compressMemories(authenticatedUserId);
        return res.status(200).json(result);
      } catch (err) {
        console.error('[memories compress] error:', err.message);
        return res.status(500).json({ error: 'Compression failed' });
      }
    }

    // One-time cleanup action
    if (action === 'cleanup') {
      try {
        const result = await cleanupDuplicates(authenticatedUserId);
        return res.status(200).json({
          message: 'Cleanup complete',
          ...result,
        });
      } catch (err) {
        console.error('[memories cleanup] error:', err.message);
        return res.status(500).json({ error: 'Cleanup failed' });
      }
    }

    // Normal fetch — return prioritized memories for the panel
    try {
      const all = await sbFetch(
        '/memories?user_id=eq.' + encodeURIComponent(authenticatedUserId) +
        '&superseded=eq.false' +
        '&order=anchor.desc,weight.desc,confidence.desc,updated_at.desc' +
        '&limit=400'
      );

      // Apply smart prioritization — show top 150 in panel
      const memories = prioritizeMemories(all, 150);

      return res.status(200).json({
        memories,
        total: all.length,
      });
    } catch (err) {
      console.error('[memories GET] error:', err.message);
      return res.status(500).json({ error: 'Failed to load memories' });
    }
  }

  // DELETE — remove a specific memory
  if (req.method === 'DELETE') {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Memory ID required' });

    try {
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
