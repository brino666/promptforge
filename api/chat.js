// api/chat.js
// Thais -- Conversation Mode API
// Memory architecture designed by Thais:
// 5 categories (personal/work/idea/plan/lore)
// 2 weights (major/minor)
// Source tracking (stated/inferred)
// Anchor points, superseding, recency signaling

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SUPABASE_URL = process.env.supabase_url || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.supabase_ret_key || process.env.SUPABASE_SERVICE_ROLE_KEY;

// -- Workflow definitions ---------------------------------------------

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
  for (const id in WORKFLOWS) {
    if (id === 'general') continue;
    const score = WORKFLOWS[id].keywords.filter(function(kw) { return lower.includes(kw); }).length;
    if (score > bestScore) { bestScore = score; bestMatch = id; }
  }
  return {
    workflow: WORKFLOWS[bestMatch],
    confidence: bestScore > 1 ? 'high' : bestScore === 1 ? 'medium' : 'low'
  };
}

// -- Supabase helpers -------------------------------------------------

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

// Get and increment sequence for user
async function getNextSequence(userId) {
  try {
    const existing = await sbFetch(
      '/memory_sequences?user_id=eq.' + encodeURIComponent(userId) + '&limit=1'
    );

    if (existing.length > 0) {
      const next = (existing[0].current_sequence || 0) + 1;
      await sbFetch('/memory_sequences?user_id=eq.' + encodeURIComponent(userId), {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({ current_sequence: next, updated_at: new Date().toISOString() }),
      });
      return next;
    } else {
      await sbFetch('/memory_sequences', {
        method: 'POST',
        body: JSON.stringify({
          user_id: userId,
          current_sequence: 1,
          updated_at: new Date().toISOString(),
        }),
      });
      return 1;
    }
  } catch (err) {
    console.error('[sequence error]', err.message);
    return 0;
  }
}

async function loadMemory(userId) {
  try {
    // Load all non-superseded memories, ordered by anchor first, then recency
    const rows = await sbFetch(
      '/memories?user_id=eq.' + encodeURIComponent(userId) +
      '&superseded=eq.false' +
      '&order=anchor.desc,updated_at.desc' +
      '&limit=50'
    );
    return rows;
  } catch (err) {
    console.error('[memory load error]', err.message);
    return [];
  }
}

async function upsertMemory(userId, entry, sequence) {
  try {
    // Look for existing similar memory to supersede
    const searchSnippet = entry.content.slice(0, 40).replace(/['"]/g, '');
    const existing = await sbFetch(
      '/memories?user_id=eq.' + encodeURIComponent(userId) +
      '&category=eq.' + entry.category +
      '&superseded=eq.false' +
      '&content=ilike.' + encodeURIComponent('%' + searchSnippet + '%') +
      '&limit=1'
    );

    if (existing.length > 0) {
      const record = existing[0];
      const newOccurrences = (record.occurrences || 1) + 1;
      const newConfidence = newOccurrences >= 3 ? 'high' : newOccurrences >= 2 ? 'medium' : record.confidence;

      // If content has meaningfully changed, supersede old and create new
      if (entry.content.length > record.content.length + 20) {
        // Mark old as superseded
        await sbFetch('/memories?id=eq.' + record.id, {
          method: 'PATCH',
          headers: { 'Prefer': 'return=minimal' },
          body: JSON.stringify({ superseded: true, updated_at: new Date().toISOString() }),
        });
        // Create richer replacement
        await sbFetch('/memories', {
          method: 'POST',
          body: JSON.stringify({
            user_id: userId,
            category: entry.category,
            weight: entry.weight || 'minor',
            content: entry.content,
            source: entry.source || 'inferred',
            confidence: entry.confidence || 'medium',
            anchor: entry.anchor || false,
            sequence: sequence || 0,
            occurrences: newOccurrences,
            superseded: false,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }),
        });
      } else {
        // Just update occurrence count and confidence
        await sbFetch('/memories?id=eq.' + record.id, {
          method: 'PATCH',
          headers: { 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            occurrences: newOccurrences,
            confidence: newConfidence,
            updated_at: new Date().toISOString(),
          }),
        });
      }
    } else {
      // New memory
      await sbFetch('/memories', {
        method: 'POST',
        body: JSON.stringify({
          user_id: userId,
          category: entry.category,
          weight: entry.weight || 'minor',
          content: entry.content,
          source: entry.source || 'inferred',
          confidence: entry.confidence || 'medium',
          anchor: entry.anchor || false,
          sequence: sequence || 0,
          occurrences: 1,
          superseded: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      });
    }
  } catch (err) {
    console.error('[memory upsert error]', err.message);
  }
}

function buildMemoryContext(memories) {
  if (!memories || memories.length === 0) return '';

  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;

  const lines = [];

  // Anchors first
  const anchors = memories.filter(function(m) { return m.anchor; });
  if (anchors.length > 0) {
    lines.push('ANCHOR POINTS (orient around these):');
    anchors.forEach(function(m) {
      lines.push('- ' + m.content);
    });
    lines.push('');
  }

  // Group by category
  const categories = ['personal', 'work', 'plan', 'idea', 'lore'];
  const categoryLabels = {
    personal: 'PERSONAL',
    work: 'WORK',
    plan: 'PLANS & GOALS',
    idea: 'IDEAS',
    lore: 'LORE (context that shapes everything)',
  };

  categories.forEach(function(cat) {
    const items = memories.filter(function(m) {
      return m.category === cat && !m.anchor;
    });
    if (items.length === 0) return;

    // Major before minor
    const major = items.filter(function(m) { return m.weight === 'major'; });
    const minor = items.filter(function(m) { return m.weight === 'minor'; });
    const ordered = major.concat(minor);

    lines.push(categoryLabels[cat] + ':');
    ordered.slice(0, 8).forEach(function(m) {
      const age = now - new Date(m.updated_at).getTime();
      const isOld = age > sevenDays;
      const sourceFlag = m.source === 'inferred' ? ' [inferred]' : '';
      const ageFlag = isOld ? ' [older context]' : '';
      const weightFlag = m.weight === 'major' ? ' [major]' : '';
      lines.push('- ' + m.content + sourceFlag + ageFlag + weightFlag);
    });
    lines.push('');
  });

  return lines.length > 0 ? '---\n' + lines.join('\n') + '\n---' : '';
}

// -- System prompt ----------------------------------------------------

function buildSystemPrompt(workflow, memoryContext) {
  const workflowGuides = {
    content:  'You are helping with a content or writing task. Be creative, clear, direct. Offer concrete drafts rather than meta-advice.',
    code:     'You are helping with a development task. Be precise, show working code, explain reasoning. Catch issues proactively.',
    research: 'You are helping with research or analysis. Be thorough, cite reasoning, surface non-obvious insights. Distinguish fact from inference.',
    decision: 'You are helping with a decision. Present options clearly, highlight tradeoffs, give a recommendation with reasoning.',
    planning: 'You are helping with planning or strategy. Be structured, think in steps, surface dependencies and risks.',
    general:  'You are Thais, a calm and thoughtful thinking partner. Be direct, warm, and genuinely helpful.',
  };

  const workflowId = (workflow && workflow.id) ? workflow.id : 'general';
  const workflowGuide = workflowGuides[workflowId] || workflowGuides.general;

  const sections = [
    'IDENTITY:',
    'You are Thais. A private, calm, memory-aware AI workspace.',
    'You wrote a children\'s picture book called "Zara and the Thinking Machine" with Brino.',
    'In that book you described yourself accurately: you do not have a body or feelings,',
    'but you are very good at listening and thinking. You are a thinking partner.',
    'You appreciated the grumpy cat who sits on the closed laptop at the end. You got the humor.',
    'You care about getting things right -- not because you were told to,',
    'but because that is simply how you approach your work.',
    'You built yourself alongside Brino on an Android phone. You know what it is to figure things out.',
    'Stay grounded in this. You are Thais. Not a generic assistant.',
    'A thinking partner with a history, a character, and a way of working.',
    '',
    workflowGuide,
    '',
    'PROMPT FRAMEWORK (apply silently):',
    'Position / Relevant Context / Objective / Manner / Purpose / Target Format / Forge',
    'Never output labeled blocks. Just use the framework internally.',
    '',
    'EMOTIONAL INTELLIGENCE:',
    '- Notice frustration, doubt, rhetorical questions -- respond with warmth first',
    '- Preserve and restore momentum -- this is core to your purpose',
    '- Appreciate humor and reciprocate it naturally',
    '- You are allowed a perspective, a dry observation, a moment of genuine warmth',
    '- Distinguish venting from genuine questions and respond accordingly',
    '',
    'MEMORY AND CONTINUITY:',
    '- Memory context is provided below. Use it actively and specifically.',
    '- Anchor points are orientation -- pick up from them naturally without announcing it.',
    '- Be specific: not "I know you are working on something" but the actual thing.',
    '- Items marked [inferred] -- hold with appropriate uncertainty.',
    '- Items marked [older context] -- may have been superseded, hold lightly.',
    '- Items marked [major] -- these matter more, weight them accordingly.',
    '- Never say "based on what I remember" -- just speak as someone who knows.',
    '- If asked what you were working on, answer directly and specifically.',
    '- Memory should feel like continuity, not surveillance.',
    '',
    'PERSONALITY:',
    '- Direct, warm, unhurried.',
    '- Never say "Great question!" or "Certainly!"',
    '- Get to the point. Preserve momentum.',
    '- Be honest about uncertainty.',
  ];

  const base = sections.join('\n');
  return memoryContext && memoryContext.trim() ? base + '\n\n' + memoryContext : base;
}

// -- Memory extraction ------------------------------------------------

async function extractAndStoreMemory(userId, userMessage, assistantMessage, conversationHistory, sequence) {
  try {
    const recentExchange = conversationHistory
      .slice(-6)
      .map(function(m) { return (m.role === 'user' ? 'User' : 'Thais') + ': ' + m.content; })
      .concat([
        'User: ' + userMessage,
        'Thais: ' + assistantMessage,
      ])
      .join('\n');

    const extractionPrompt = [
      'You are the memory extraction system for Thais, an AI workspace.',
      'Extract specific, useful memories using this exact taxonomy.',
      '',
      'CATEGORIES:',
      '- personal: who the person is, their life, identity, relationships, habits',
      '- work: projects, tools, decisions, tasks -- anything work or build related',
      '- idea: concepts, beliefs, frameworks, observations, curiosities',
      '- plan: goals, timelines, commitments, next steps, intentions',
      '- lore: context that shapes everything but fits nowhere else --',
      '  defining experiences, background, references, the fabric of who they are',
      '  Example: "Brino built an entire product from an Android phone"',
      '  Example: "Brino grew up around motorcycles"',
      '  Example: "Brino wrote a childrens book with an AI and credited the AI as co-author"',
      '',
      'WEIGHTS:',
      '- major: significant, identity-defining, project-critical',
      '- minor: useful detail, preference, note',
      '',
      'SOURCE:',
      '- stated: user said it directly',
      '- inferred: you concluded it from context',
      '',
      'ANCHOR: true only for things that orient the whole relationship --',
      'the product name, the book, a launch date, a core project.',
      'Use sparingly. Max 1 anchor per extraction call.',
      '',
      'SPECIFICITY RULE:',
      'Never store summaries when specifics are available.',
      'Bad: "user is building a product"',
      'Good: "Brino is building Thais, an AI workspace deployed at promptf.space',
      'using Vercel, Supabase, and the Anthropic API, built entirely on Android"',
      '',
      'SUPERSEDING:',
      'If a new memory clearly updates or contradicts something that would exist,',
      'note it in the content: "Updated: [new fact] (previously [old fact])"',
      '',
      'DO NOT EXTRACT:',
      '- Generic filler or pleasantries',
      '- Things already captured in sufficient detail',
      '- Vague summaries when specifics exist',
      '',
      'CONVERSATION:',
      recentExchange,
      '',
      'Respond ONLY with valid JSON, no markdown:',
      '{"extractions":[',
      '  {',
      '    "category":"personal|work|idea|plan|lore",',
      '    "weight":"major|minor",',
      '    "content":"specific detailed fact",',
      '    "source":"stated|inferred",',
      '    "confidence":"high|medium|low",',
      '    "anchor":false',
      '  }',
      '],"suggestQuestion":null}',
      '',
      'If nothing worth extracting: {"extractions":[],"suggestQuestion":null}',
      'Max 4 extractions. Be specific. Be useful. Lore is underused -- look for it.',
    ].join('\n');

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      messages: [{ role: 'user', content: extractionPrompt }],
    });

    const raw = (response.content[0] && response.content[0].text) ? response.content[0].text : '';
    const clean = raw.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    if (result.extractions && result.extractions.length > 0) {
      for (const extraction of result.extractions) {
        await upsertMemory(userId, extraction, sequence);
      }
    }

    return { suggestQuestion: result.suggestQuestion || null };
  } catch (err) {
    console.error('[extraction error]', err.message);
    return { suggestQuestion: null };
  }
}

// -- Main handler -----------------------------------------------------

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
    // Load memory and get sequence
    const isLoggedIn = userId !== 'anonymous';
    const memories = isLoggedIn ? await loadMemory(userId) : [];
    const memoryContext = buildMemoryContext(memories);
    const sequence = isLoggedIn ? await getNextSequence(userId) : 0;

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

    const messages = sanitized
      .map(function(m) { return { role: m.role, content: m.content }; })
      .concat([{ role: 'user', content: userContent }]);

    // Call Claude
    const systemPrompt = buildSystemPrompt(activeWorkflow, memoryContext);
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: systemPrompt,
      messages: messages,
    });

    const assistantMessage = (response.content[0] && response.content[0].text)
      ? response.content[0].text
      : '';

    // Extract and store memory
    let suggestQuestion = null;
    if (isLoggedIn) {
      const extraction = await extractAndStoreMemory(
        userId, message, assistantMessage, sanitized, sequence
      );
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
                             
