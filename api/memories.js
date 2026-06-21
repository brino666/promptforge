// api/memories.js
// Thais — Secure memory fetch + cleanup endpoint
// FIX: Added supabase_non_key fallback for Vercel typo
// FIX: Smarter memory prioritization (anchor > major > confidence > recency)
// NEW: /api/memories?action=cleanup for one-time dedup of existing memories

import { MODEL_FAST, MODEL_MAIN } from '../config/models.js';
import { scoreEntry, decideTier } from '../memory/scorer.js';

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

// Smart memory prioritization for the panel: recency-led so the user can
// actually see new/changed memories as they're created, with anchor/weight/
// confidence used only as small tie-breaking nudges rather than letting old
// "major"/"high confidence" entries permanently bury everything newer.
function prioritizeMemories(memories, limit) {
  const score = function(m) {
    let s = 0;
    // Recency dominates — this is what makes new memories visible at all.
    const age = Date.now() - new Date(m.updated_at).getTime();
    const daysOld = age / (1000 * 60 * 60 * 24);
    s += Math.max(0, 100 - daysOld); // up to +100 for something updated this moment, decaying over ~100 days
    if (m.anchor) s += 20;
    if (m.weight === 'major') s += 10;
    if (m.confidence === 'high') s += 6;
    if (m.confidence === 'medium') s += 3;
    if (m.source === 'stated') s += 2;
    // Occurrence bonus — things mentioned multiple times are more reliable
    s += Math.min((m.occurrences || 1) * 1, 5);
    return s;
  };

  return memories
    .slice()
    .sort(function(a, b) { return score(b) - score(a); })
    .slice(0, limit);
}


// Finds any live memory describing the diagnostic injection pipeline as broken
// (whether an original duplicate or the consolidated replacement) and supersedes
// it with a corrected, resolved-status entry. The underlying code bug (chat.js
// was making a self-fetch HTTP call to its own deployment instead of calling
// getMemoryStats() directly) was fixed; this clears the stale claim out of memory
// so Thais stops reciting an outdated bug report as current fact.
export async function resolveDiagnosticMemory(userId) {
  const all = await sbFetch(
    '/memories?user_id=eq.' + encodeURIComponent(userId) +
    '&superseded=eq.false' +
    '&limit=500'
  );

  if (!all || all.length === 0) return { superseded: 0, inserted: 0 };

  const matches = all.filter(function(m) {
    const c = (m.content || '').toLowerCase();
    if (!c.includes('diagnostic')) return false;
    if (c.includes('fixed') || c.includes('verified')) return false; // already the correct statement
    return c.includes('inject') || c.includes('broken') || c.includes('pending') || c.includes('does not reach') || c.includes('bug');
  });

  let superseded = 0;
  for (const m of matches) {
    try {
      await sbFetch('/memories?id=eq.' + encodeURIComponent(m.id), {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({ superseded: true, updated_at: new Date().toISOString() }),
      });
      superseded++;
    } catch (err) {
      console.error('[resolve-diagnostic] failed to supersede', m.id, err.message);
    }
  }

  let inserted = 0;
  if (superseded > 0) {
    try {
      await sbFetch('/memories', {
        method: 'POST',
        body: JSON.stringify({
          user_id: userId,
          category: 'work',
          weight: 'minor',
          content: 'The diagnostic injection bug is fixed: getMemoryStats() is now called directly in chat.js instead of an unreliable self-fetch over HTTP. The diagnostic pipeline runs and injects real data into the system prompt before each response, verified.',
          source: 'synthesized',
          confidence: 'high',
          anchor: false,
          sequence: 0,
          occurrences: superseded,
          superseded: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      });
      inserted = 1;
    } catch (err) {
      console.error('[resolve-diagnostic] failed to insert resolution', err.message);
    }
  }

  return { superseded, inserted };
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
        // Check for high word overlap (strip punctuation, drop common stopwords
        // so short factual statements like "the user's name is X" phrased
        // differently still get caught as duplicates)
        const stop = new Set(['the','a','an','and','or','but','is','are','was','were','be','been','to','of','in','on','for','with','at','by','from','as','that','this','it','user','users']);
        function words(s) {
          return (s.match(/[a-z0-9']+/g) || []).filter(function(w) { return w.length > 2 && !stop.has(w); });
        }
        const itemWords = new Set(words(itemLower));
        const keptWords = new Set(words(keptLower));
        if (itemWords.size === 0) return false;
        let overlap = 0;
        itemWords.forEach(function(w) { if (keptWords.has(w)) overlap++; });
        const similarity = overlap / Math.max(itemWords.size, keptWords.size);
        return similarity > 0.5;
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

// One-time deep consolidation: unlike compressMemories (30+ day old only,
// batches of 10) or cleanupDuplicates (pairwise heuristic), this sends every
// non-anchor memory in a category to Claude in one shot and asks it to
// collapse the whole set down to the truly distinct facts, regardless of age
// or how differently each duplicate was worded.
const DEEP_CONSOLIDATE_PROMPT = `You are cleaning up a personal AI's memory store, which has accumulated many duplicate and near-duplicate entries -- the same fact stored multiple times with slightly different wording.

You will be given every memory currently stored in one category. Your job:
- Merge entries that describe the same underlying fact (even if worded very differently) into one clear statement.
- Keep entries that are genuinely distinct facts, even if they're short.
- Prefer the most specific, complete wording available across the merged entries.
- Do not invent anything not present in the source entries.
- Discard entries that are too vague to be useful on their own AND fully covered by a more specific entry.

Respond ONLY with valid JSON, no markdown:
{"statements":[{"content":"...","mergedCount":N,"weight":"major|minor"}]}

mergedCount = how many of the input entries this statement absorbs (1 if it was already unique).`;

async function deepConsolidate(userId) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('No API key configured for consolidation');

  const all = await sbFetch(
    '/memories?user_id=eq.' + encodeURIComponent(userId) +
    '&anchor=eq.false' +
    '&superseded=eq.false' +
    '&order=category.asc' +
    '&limit=500'
  );

  if (!all || all.length === 0) return { categoriesProcessed: 0, superseded: 0, inserted: 0 };

  // Already-synthesized memories are canonical, condensed corrections (e.g. bug-fix
  // confirmations). Re-merging them risks an LLM flattening/rewording away the exact
  // distinction (fixed vs. broken) that made them worth writing in the first place --
  // this happened once already and produced a false "still broken" memory. Leave them
  // untouched.
  const candidates = all.filter(function(m) { return m.source !== 'synthesized'; });

  const grouped = {};
  for (const m of candidates) {
    if (!grouped[m.category]) grouped[m.category] = [];
    grouped[m.category].push(m);
  }

  let categoriesProcessed = 0;
  let totalSuperseded = 0;
  let totalInserted = 0;

  for (const [category, memories] of Object.entries(grouped)) {
    if (memories.length < 2) continue;

    const memoryList = memories
      .map((m, idx) => `${idx + 1}. [${m.confidence}, ${m.weight}] ${m.content}`)
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
          model: MODEL_MAIN,
          max_tokens: 1500,
          system: DEEP_CONSOLIDATE_PROMPT,
          messages: [{
            role: 'user',
            content: `Category: ${category}\n\nMemories:\n${memoryList}`,
          }],
        }),
      });

      const data = await response.json();
      const text = data.content?.[0]?.text;
      if (!text) continue;

      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      const statements = (parsed.statements || []).filter((s) => s && s.content && s.content.length > 5);
      if (statements.length === 0) continue;

      // Only worth it if we're actually shrinking the set
      if (statements.length >= memories.length) continue;

      for (const m of memories) {
        try {
          await sbFetch('/memories?id=eq.' + m.id, {
            method: 'PATCH',
            headers: { 'Prefer': 'return=minimal' },
            body: JSON.stringify({ superseded: true, updated_at: new Date().toISOString() }),
          });
          totalSuperseded++;
        } catch (err) {
          console.error('[deep-consolidate] failed to supersede', m.id, err.message);
        }
      }

      for (const stmt of statements) {
        try {
          const mergedCount = stmt.mergedCount || 1;
          await sbFetch('/memories', {
            method: 'POST',
            body: JSON.stringify({
              user_id: userId,
              category,
              weight: stmt.weight === 'major' ? 'major' : 'minor',
              content: stmt.content,
              source: 'synthesized',
              confidence: mergedCount >= 2 ? 'high' : 'medium',
              anchor: false,
              sequence: 0,
              occurrences: mergedCount,
              superseded: false,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }),
          });
          totalInserted++;
        } catch (err) {
          console.error('[deep-consolidate] failed to store statement', err.message);
        }
      }

      categoriesProcessed++;
    } catch (err) {
      console.error('[deep-consolidate] failed for category', category, err.message);
    }
  }

  return { categoriesProcessed, superseded: totalSuperseded, inserted: totalInserted };
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

    if (action === 'deep-consolidate') {
      try {
        const result = await deepConsolidate(authenticatedUserId);
        return res.status(200).json({
          message: `Deep consolidation complete: merged ${result.superseded} memories into ${result.inserted} across ${result.categoriesProcessed} categories`,
          ...result,
        });
      } catch (err) {
        console.error('[memories deep-consolidate] error:', err.message);
        return res.status(500).json({ error: 'Deep consolidation failed' });
      }
    }

    if (action === 'resolve-diagnostic') {
      try {
        const result = await resolveDiagnosticMemory(authenticatedUserId);
        return res.status(200).json({
          message: result.superseded > 0
            ? 'Stale diagnostic-pipeline memory resolved'
            : 'No stale diagnostic-pipeline memory found',
          ...result,
        });
      } catch (err) {
        console.error('[memories resolve-diagnostic] error:', err.message);
        return res.status(500).json({ error: 'Resolution failed' });
      }
    }

    // Normal fetch — return prioritized memories for the panel
    try {
      // Order by recency at the DB level too -- otherwise with 400+ rows
      // stored, a weight/confidence-first order can cut off the newest
      // (still low-confidence/unconfirmed) memories before they're even
      // fetched, so they'd never reach the prioritization step below.
      const all = await sbFetch(
        '/memories?user_id=eq.' + encodeURIComponent(authenticatedUserId) +
        '&superseded=eq.false' +
        '&order=updated_at.desc' +
        '&limit=400'
      );

      // Apply smart prioritization — show top 200 in panel
      const memories = prioritizeMemories(all, 200);

      // Tag each memory with its Constitution memory tier (active/working/knowledge/archive),
      // computed live so the user can see why a memory is weighted the way it is.
      const tagged = memories.map(function(m) {
        return Object.assign({}, m, { tier: decideTier(scoreEntry(m), m) });
      });

      return res.status(200).json({
        memories: tagged,
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
