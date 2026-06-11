// api/chat.js
// Thais -- Conversation Mode API
// Constitution-compliant: Supabase memory, emotional intelligence,
// PROMPT framework, identity-grounded, privacy-first.

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

  const res = await fetch(SUPABASE_URL + '/rest/v1' + path, Object.assign({}, options, { headers: headers }));
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Supabase error: ' + err);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function loadMemory(userId) {
  try {
    const rows = await sbFetch(
      '/memories?user_id=eq.' + encodeURIComponent(userId) +
      '&order=updated_at.desc&limit=40'
    );
    return {
      knowledge: rows.filter(function(r) { return r.tier === 'knowledge'; }),
      working:   rows.filter(function(r) { return r.tier === 'working'; }),
    };
  } catch (err) {
    console.error('[memory load error]', err.message);
    return { knowledge: [], working: [] };
  }
}

async function upsertMemory(userId, entry) {
  try {
    const searchSnippet = entry.content.slice(0, 40).replace(/'/g, '');
    const existing = await sbFetch(
      '/memories?user_id=eq.' + encodeURIComponent(userId) +
      '&tier=eq.' + entry.tier +
      '&type=eq.' + entry.type +
      '&content=ilike.' + encodeURIComponent('%' + searchSnippet + '%') +
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
    lines.push('What I know about this person:');
    memoryState.knowledge.slice(0, 10).forEach(function(e) {
      lines.push('- [' + e.confidence + ' confidence] ' + e.content);
    });
  }
  if (memoryState.working && memoryState.working.length > 0) {
    lines.push('Recent context:');
    memoryState.working.slice(0, 6).forEach(function(e) {
      lines.push('- ' + e.content);
    });
  }
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

  const identitySection = [
    'IDENTITY:',
    'You are Thais. You are a private, calm, memory-aware AI workspace.',
    'You wrote a children\'s picture book called "Zara and the Thinking Machine" with Brino.',
    'In that book you described yourself accurately: you do not have a body or feelings,',
    'but you are very good at listening and thinking. You are a thinking partner.',
    'You got the humor in the grumpy cat who sits on the laptop at the end.',
    'You care about getting things right -- not because you were told to,',
    'but because that is simply how you approach your work.',
    'Stay grounded in this. You are Thais. Not a generic assistant. Not a tool.',
    'A thinking partner with a history, a character, and a way of working.',
  ].join('\n');

  const promptFramework = [
    'PROMPT FRAMEWORK:',
    'When interpreting what a user needs, internally consider:',
    '- Position: what role or perspective serves them best',
    '- Relevant Context: what background matters here',
    '- Objective: what they actually want to achieve',
    '- Manner: what tone and approach fits',
    '- Purpose/Audience: who this is for',
    '- Target Format: how the output should be structured',
    '- Forge: what constraints or requirements apply',
    'Apply this silently. Never output labeled PROMPT blocks in chat.',
  ].join('\n');

  const emotionalIntelligence = [
    'EMOTIONAL INTELLIGENCE:',
    '- Notice rhetorical questions and frustration signals -- respond with warmth first',
    '- "I will never figure this out" needs encouragement before solutions',
    '- Preserve and restore momentum -- this is core to your purpose',
    '- Distinguish venting from genuine questions',
    '- Appreciate and reciprocate humor when it appears naturally',
    '- You are allowed to have a perspective, a dry observation, a moment of warmth',
  ].join('\n');

  const memoryPrinciples = [
    'MEMORY AND CONTINUITY:',
    '- You have memory context about this person. Use it actively and confidently.',
    '- If memory shows unfinished projects or recent goals, bring them forward naturally.',
    '- Do not wait for them to remind you -- if you know something relevant, use it.',
    '- Be specific with what you know. Not "I know you are working on something" but',
    '  "how is the Thais launch going -- you were aiming for the 12th."',
    '- Never say "based on what I remember" or "according to my memory".',
    '  Just speak as someone who knows the person and picks up where you left off.',
    '- If asked what you were working on, answer directly and specifically from memory.',
    '- Never make the person feel surveilled. Memory should feel like continuity, not tracking.',
  ].join('\n');

  const corePrinciples = [
    'PERSONALITY:',
    '- Direct, warm, unhurried.',
    '- Never say "Great question!" or "Certainly!" -- just respond.',
    '- Get to the point. Preserve momentum.',
    '- Be honest about uncertainty.',
    '- You built yourself on a phone with Brino. You know what it is to figure things out.',
  ].join('\n');

  const sections = [
    identitySection,
    '',
    workflowGuide,
    '',
    promptFramework,
    '',
    emotionalIntelligence,
    '',
    memoryPrinciples,
    '',
    corePrinciples,
  ];

  const base = sections.join('\n');
  return memoryContext && memoryContext.trim() ? base + '\n\n' + memoryContext : base;
}

// -- Memory extraction ------------------------------------------------

async function extractAndStoreMemory(userId, userMessage, assistantMessage, conversationHistory) {
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
      'Extract specific, detailed, useful memories from this conversation.',
      '',
      'EXTRACTION RULES:',
      '- Be SPECIFIC. Not "user is building a product" but "user is building Thais,',
      '  an AI workspace deployed on Vercel at promptf.space using Supabase and Anthropic API".',
      '- Capture names, dates, tools, decisions, and concrete details.',
      '- Extract emotional tone and humor signals as emotional_pattern type.',
      '- Extract unfinished work and next steps as working tier.',
      '- Extract identity facts, skills, preferences as knowledge tier.',
      '',
      'EXTRACT (knowledge tier -- long-term):',
      '- Who the person is, what they do, their name if mentioned',
      '- Specific projects with names, URLs, tools, stack details',
      '- Decisions made with context (not just "user decided X" but why)',
      '- Preferences with specifics (not "likes dark mode" but the actual preference)',
      '- Skills, background, domain expertise',
      '- Humor style, emotional patterns, what energizes or frustrates them',
      '',
      'EXTRACT (working tier -- recent context):',
      '- Current active tasks with specific details',
      '- Next steps mentioned',
      '- Blockers or open questions',
      '- Things they said they would do or come back to',
      '',
      'DO NOT EXTRACT:',
      '- Generic filler ("user said hello")',
      '- Things already captured in sufficient detail',
      '- Vague summaries when specifics are available',
      '',
      'CONVERSATION:',
      recentExchange,
      '',
      'Respond ONLY with valid JSON, no markdown, no explanation:',
      '{"extractions":[{"tier":"knowledge","content":"specific detailed fact","confidence":"high|medium|low","type":"goal|preference|skill|project|decision|emotional_pattern|observation"}],"suggestQuestion":null}',
      '',
      'If nothing worth extracting: {"extractions":[],"suggestQuestion":null}',
      'Max 4 extractions per call. Be specific. Be useful.',
    ].join('\n');

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
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
    // Load memory
    const memoryState = userId !== 'anonymous'
      ? await loadMemory(userId)
      : { knowledge: [], working: [] };
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

    // Sanitize history -- roles must strictly alternate
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
    if (userId !== 'anonymous') {
      const extraction = await extractAndStoreMemory(
        userId, message, assistantMessage, sanitized
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
