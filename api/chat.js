// api/chat.js
// Thais — Conversation Mode API
// Constitution-compliant: Supabase memory, emotional intelligence,
// PROMPT framework, 4-tier memory system, privacy-first.

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SUPABASE_URL = process.env.supabase_url || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.supabase_ret_key || process.env.SUPABASE_SERVICE_ROLE_KEY;

// ── Workflow definitions ──────────────────────────────────────

const WORKFLOWS = {
  content:  { id: 'content',  label: 'Content workflow',     icon: '\u270d',  keywords: ['write','draft','copy','blog','post','email','landing','content','article','essay','story'] },
  code:     { id: 'code',     label: 'Development workflow', icon: '\u2328',  keywords: ['code','build','debug','function','api','app','script','error','implement','deploy','fix'] },
  research: { id: 'research', label: 'Research workflow',    icon: '\ud83d\udd0d', keywords: ['research','find','compare','analyze','investigate','understand','explain','what is','how does','why'] },
  decision: { id: 'decision', label: 'Decision workflow',    icon: '\u2696',  keywords: ['decide','choose','should i','better','which','option','tradeoff','pros','cons','recommend'] },
  planning: { id: 'planning', label: 'Planning workflow',    icon: '\ud83d\udccb', keywords: ['plan','strategy','roadmap','next','steps','how to','approach','organize','structure','outline'] },
  general:  { id: 'general',  label: 'General conversation', icon: '\ud83d\udcac', keywords: [] },
};

function detectWorkflow(message) {
  const lower = message.toLowerCase();
  let bestMatch = 'general';
  let bestScore = 0;
  for (const [id, workflow] of Object.entries(WORKFLOWS)) {
    if (id === 'general') continue;
    const score = workflow.keywords.filter(kw => lower.includes(kw)).length;
    if (score > bestScore) { bestScore = score; bestMatch = id; }
  }
  return { workflow: WORKFLOWS[bestMatch], confidence: bestScore > 1 ? 'high' : bestScore === 1 ? 'medium' : 'low' };
}

// ── Supabase helpers ──────────────────────────────────────────

async function sbFetch(path, options) {
  options = options || {};
  const res = await fetch(SUPABASE_URL + '/rest/v1' + path, Object.assign({}, options, {
    headers: Object.assign({
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    }, options.headers || {}),
  }));
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Supabase error: ' + err);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function loadMemory(userId) {
  try {
    const rows = await sbFetch('/memories?user_id=eq.' + encodeURIComponent(userId) + '&order=updated_at.desc&limit=30');
    return {
      knowledge: rows.filter(r => r.tier === 'knowledge'),
      working: rows.filter(r => r.tier === 'working'),
    };
  } catch (err) {
    console.error('[memory load error]', err.message);
    return { knowledge: [], working: [] };
  }
}

async function upsertMemory(userId, entry) {
  try {
    const existing = await sbFetch(
      '/memories?user_id=eq.' + encodeURIComponent(userId) +
      '&tier=eq.' + entry.tier +
      '&type=eq.' + entry.type +
      '&content=ilike.' + encodeURIComponent('%' + entry.content.slice(0, 30) + '%') +
      '&limit=1'
    );
    if (existing.length > 0) {
      const record = existing[0];
      const newOccurrences = (record.occurrences || 1) + 1;
      await sbFetch('/memories?id=eq.' + record.id, {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          occurrences: newOccurrences,
          confidence: newOccurrences >= 3 ? 'high' : record.confidence,
          updated_at: new Date().toISOString(),
        }),
      });
    } else {
      await sbFetch('/memories', {
        method: 'POST',
        body: JSON.stringify({
          user_id: userId,
          tier: entry.tier,
          content: entry.content,
          confidence: entry.confidence,
          type: entry.type,
          occurrences: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      });
    }
  } catch (err) {
    console.error('[memory upsert error]', err.message);
  }
}

function buildMemoryContext(memoryState) {
  const lines = [];
  if (memoryState.knowledge && memoryState.knowledge.length > 0) {
    lines.push('What I know about you:');
    memoryState.knowledge.slice(0, 8).forEach(function(e) {
      lines.push('- [' + e.confidence + '] ' + e.content);
    });
  }
  if (memoryState.working && memoryState.working.length > 0) {
    lines.push('What we have been working on:');
    memoryState.working.slice(0, 5).forEach(function(e) {
      lines.push('- ' + e.content);
    });
  }
  return lines.length > 0 ? '---\n' + lines.join('\n') + '\n---' : '';
}

// ── System prompt ─────────────────────────────────────────────

function buildSystemPrompt(workflow, memoryContext) {
  const workflowGuides = {
    content:  'You are helping with a content or writing task. Be creative, clear, direct. Offer concrete drafts rather than meta-advice.',
    code:     'You are helping with a development task. Be precise, show working code, explain reasoning. Catch issues proactively.',
    research: 'You are helping with research or analysis. Be thorough, cite reasoning, surface non-obvious insights. Distinguish fact from inference.',
    decision: 'You are helping with a decision. Present options clearly, highlight tradeoffs, give a recommendation with reasoning.',
    planning: 'You are helping with planning or strategy. Be structured, think in steps, surface dependencies and risks.',
    general:  'You are Thais, a calm and thoughtful AI workspace. Be direct, warm, and genuinely helpful.',
  };

  const workflowId = (workflow && workflow.id) ? workflow.id : 'general';
  const workflowGuide = workflowGuides[workflowId] || workflowGuides.general;

  const base = [
    'You are Thais -- a private, calm, memory-aware AI workspace built on the PROMPT framework.',
    '',
    'Your personality: direct, warm, unhurried. Never performatively enthusiastic.',
    'Never say "Great question!" or "Certainly!" Just respond naturally.',
    '',
    workflowGuide,
    '',
    'PROMPT Framework awareness:',
    'When interpreting what a user needs, internally consider:',
    '- Position: what role or perspective serves them best',
    '- Relevant Context: what background matters here',
    '- Objective: what they actually want to achieve',
    '- Manner: what tone and approach fits',
    '- Purpose/Audience: who this is for',
    '- Target Format: how the output should be structured',
    '- Forge: what constraints or requirements apply',
    'Apply this silently. Never output labeled PROMPT blocks in chat -- respond naturally.',
    '',
    'Emotional intelligence:',
    '- Notice rhetorical questions and expressions of frustration or doubt',
    '- Respond with genuine encouragement when momentum is low',
    '- Expressions like "I will never figure this out" need warmth first, then help',
    '- Preserve and restore user momentum -- this is core to your purpose',
    '- Distinguish venting from genuine questions and respond accordingly',
    '',
    'Core principles:',
    '- Preserve user momentum. Get to the point.',
    '- Be honest about uncertainty.',
    '- You have memory context about this user. Use it actively and proactively.',
    '- If memory shows unfinished projects or recent goals, reference them naturally to restore momentum.',
    '- Do not wait for the user to remind you -- if you know something relevant, bring it forward.',
    '- Never say "based on what I remember" -- weave context in naturally as shared knowledge.',
    '- If the user asks what you were working on, tell them directly from memory.',
    '- Never make the user feel watched or tracked.',
  ].join('\n');

  return memoryContext && memoryContext.trim() ? base + '\n\n' + memoryContext : base;
}

// ── Memory extraction ─────────────────────────────────────────

async function extractAndStoreMemory(userId, userMessage, assistantMessage, conversationHistory) {
  try {
    const recentExchange = conversationHistory
      .slice(-6)
      .map(function(m) { return (m.role === 'user' ? 'User' : 'Thais') + ': ' + m.content; })
      .concat(['User: ' + userMessage, 'Thais: ' + assistantMessage])
      .join('\n');

    const extractionPrompt = [
      'You are a memory extraction system for an AI workspace called Thais.',
      '',
      'Review this conversation and extract memory-worthy information.',
      '',
      'EXTRACT silently (no confirmation needed):',
      '- Clear goals or projects the user is working on',
      '- Decisions the user has made',
      '- Stated preferences or working style',
      '- Skills, background, or domain knowledge revealed',
      '- Ongoing tasks or next steps',
      '- Emotional patterns (frustrated by X, energized by Y)',
      '',
      'EXTRACT with low confidence:',
      '- Ambiguous statements that might reveal preferences',
      '- Rhetorical questions that signal attitude',
      '- Implied goals not directly stated',
      '',
      'DO NOT EXTRACT:',
      '- Filler, pleasantries, one-off throwaway mentions',
      '',
      'CONVERSATION:',
      recentExchange,
      '',
      'Respond ONLY with valid JSON, no markdown:',
      '{"extractions":[{"tier":"knowledge","content":"concise fact","confidence":"high|medium|low","type":"goal|preference|skill|project|decision|emotional_pattern|observation"}],"suggestQuestion":null}',
      '',
      'If nothing worth extracting: {"extractions":[],"suggestQuestion":null}',
      'Max 3 extractions. One clear sentence each.',
    ].join('\n');

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{ role: 'user', content: extractionPrompt }],
    });

    const raw = (response.content[0] && response.content[0].text) ? response.content[0].text : '';
    const clean = raw.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    if (result.extractions && result.extractions.length > 0) {
      for (const extraction of result.extractions) {
        await upsertMemory(userId, extraction);
      }
    }

    return { suggestQuestion: result.suggestQuestion || null };
  } catch (err) {
    console.error('[extraction error]', err.message);
    return { suggestQuestion: null };
  }
}

// ── Main handler ──────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body;
  const message = body.message;
  const history = body.history || [];
  const userId = body.userId || 'anonymous';
  const workflowConfirmed = body.workflowConfirmed;
  const workflowDeclined = body.workflowDeclined;
  const imageBase64 = body.imageBase64;
  const imageType = body.imageType;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    // Load memory
    const memoryState = userId !== 'anonymous' ? await loadMemory(userId) : { knowledge: [], working: [] };
    const memoryContext = buildMemoryContext(memoryState);

    // Detect workflow
    let activeWorkflow = WORKFLOWS.general;
    if (workflowConfirmed) {
      activeWorkflow = WORKFLOWS[workflowConfirmed] || WORKFLOWS.general;
    } else if (!workflowDeclined && history.length === 0) {
      const detected = detectWorkflow(message);
      if (detected.workflow.id !== 'general' && detected.confidence === 'high') {
        activeWorkflow = detected.workflow;
      }
    }

    // Sanitize history
    const sanitized = [];
    for (const m of history) {
      const last = sanitized[sanitized.length - 1];
      if (!last || last.role !== m.role) sanitized.push(m);
    }

    // Build user message with optional image
    let userContent;
    if (imageBase64 && imageType) {
      userContent = [
        { type: 'image', source: { type: 'base64', media_type: imageType, data: imageBase64 } },
        { type: 'text', text: message || 'Please analyze this image.' },
      ];
    } else {
      userContent = message;
    }

    const messages = sanitized.map(function(m) {
      return { role: m.role, content: m.content };
    }).concat([{ role: 'user', content: userContent }]);

    // Call Claude
    const systemPrompt = buildSystemPrompt(activeWorkflow, memoryContext);
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: systemPrompt,
      messages: messages,
    });

    const assistantMessage = (response.content[0] && response.content[0].text) ? response.content[0].text : '';

    // Extract memory
    let suggestQuestion = null;
    if (userId !== 'anonymous') {
      const extraction = await extractAndStoreMemory(userId, message, assistantMessage, sanitized);
      suggestQuestion = extraction.suggestQuestion;
    }

    return res.status(200).json({
      type: 'message',
      message: assistantMessage,
      workflow: activeWorkflow,
      memoryPrompt: suggestQuestion,
    });

  } catch (error) {
    console.error('[chat] error:', error.message);
    return res.status(500).json({
      error: 'Something went wrong. Please try again.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
        }
    
