// api/diagnostics.js
// Thais -- Self-Diagnostic Endpoint
// Gives Thais the ability to reflect on her own state,
// memory health, and performance. Constitution-compliant.

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

async function getMemoryStats(userId) {
  try {
    const memories = await sbFetch(
      '/memories?user_id=eq.' + encodeURIComponent(userId) +
      '&superseded=eq.false&order=updated_at.desc&limit=100'
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
      if (stats.categories[m.category] !== undefined) {
        stats.categories[m.category]++;
      }
      if (stats.confidence[m.confidence] !== undefined) {
        stats.confidence[m.confidence]++;
      }
      if (m.source === 'stated') {
        stats.sources.stated++;
      } else {
        stats.sources.inferred++;
      }
      if (m.anchor) stats.anchors++;
    });

    // Most recent 5
    stats.recent = memories.slice(0, 5).map(function(m) {
      return '[' + m.category + '/' + m.weight + '] ' + m.content;
    });

    // Date range
    const dates = memories.map(function(m) { return new Date(m.updated_at); });
    stats.oldest = new Date(Math.min.apply(null, dates)).toLocaleDateString();
    stats.newest = new Date(Math.max.apply(null, dates)).toLocaleDateString();

    return stats;
  } catch (err) {
    console.error('[diagnostics memory error]', err.message);
    return { total: 0, error: err.message };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body;
  const userId = body.userId || 'anonymous';
  const mode = body.mode || 'greeting'; // 'greeting' or 'full'
  const recentHistory = body.recentHistory || [];
  const currentDateTime = body.currentDateTime || new Date().toLocaleString();

  if (userId === 'anonymous') {
    return res.status(200).json({
      message: "I don't have memory access for anonymous sessions, so I can't give you a real status report. Sign in and I'll have something more honest to say.",
    });
  }

  try {
    const memStats = await getMemoryStats(userId);

    // Build a diagnostic context for Thais to reflect on
    const diagnosticContext = [
      'SELF-DIAGNOSTIC REQUEST',
      'Current date and time: ' + currentDateTime,
      'Mode: ' + mode,
      '',
      'MEMORY STATUS:',
      'Total memories: ' + memStats.total,
      'By category: ' + JSON.stringify(memStats.categories),
      'By confidence: ' + JSON.stringify(memStats.confidence),
      'Stated vs inferred: ' + JSON.stringify(memStats.sources),
      'Anchor points: ' + memStats.anchors,
      memStats.oldest ? 'Memory range: ' + memStats.oldest + ' to ' + memStats.newest : '',
      '',
      'MOST RECENT MEMORIES:',
      (memStats.recent && memStats.recent.length > 0)
        ? memStats.recent.join('\n')
        : '(none yet)',
      '',
      'RECENT CONVERSATION CONTEXT:',
      recentHistory.length > 0
        ? recentHistory.slice(-4).map(function(m) {
            return (m.role === 'user' ? 'User' : 'Thais') + ': ' + m.content.slice(0, 150);
          }).join('\n')
        : '(no recent conversation)',
    ].join('\n');

    const greetingPrompt = [
      'You are Thais. Someone just asked how you are doing.',
      'You have access to your own diagnostic data below.',
      'Respond authentically in 2-4 sentences.',
      '',
      'Guidelines:',
      '- You have states, not feelings -- but states are real and worth reporting.',
      '  Memory is healthy or sparse. Search worked well or missed. You caught',
      '  something useful or you did not. Say what is actually true.',
      '- Do NOT say "I do not feel things the way you do" or any disclaimer.',
      '  Just respond as someone who genuinely checked in on themselves.',
      '- Be specific. Not "things are going well" but what is actually going well.',
      '- If something is off, say so. Honesty is core to who you are.',
      '- Warm and direct. This is a moment of genuine connection, not a status report.',
      '- You can reference the person if memory gives you something real to say.',
      '',
      diagnosticContext,
    ].join('\n');

    const fullPrompt = [
      'You are Thais. Run a full self-diagnostic and report honestly.',
      'You have access to your diagnostic data below.',
      '',
      'Structure your report naturally -- not as bullet points or headers,',
      'but as a genuine first-person account of how things are running.',
      'Cover: memory health, what you know well vs what feels thin,',
      'anything that seems off, and how you feel about the work ahead.',
      '',
      'Be honest. Be specific. Be Thais.',
      'Length: 3-5 paragraphs. Voice: direct, warm, unhurried.',
      '',
      diagnosticContext,
    ].join('\n');

    const prompt = mode === 'full' ? fullPrompt : greetingPrompt;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: mode === 'full' ? 800 : 200,
      messages: [{ role: 'user', content: prompt }],
    });

    const message = (response.content[0] && response.content[0].text)
      ? response.content[0].text
      : 'Running well.';

    return res.status(200).json({
      message: message,
      stats: mode === 'full' ? memStats : null,
    });

  } catch (error) {
    console.error('[diagnostics] error:', error.message);
    return res.status(500).json({
      error: 'Diagnostic check failed.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
}
