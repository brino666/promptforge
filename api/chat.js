// api/chat.js
// Thais -- Conversation Mode API
// With web search capability via Brave Search API

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SUPABASE_URL = process.env.supabase_url || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.supabase_ret_key || process.env.SUPABASE_SERVICE_ROLE_KEY;
const BRAVE_KEY = process.env.BRAVE_SEARCH_KEY;
const BASE_URL = process.env.VERCEL_URL
  ? 'https://' + process.env.VERCEL_URL
  : 'https://promptforge-n3yh.vercel.app';

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

// -- Greeting / self-check detection ---------------------------------

function isGreeting(message) {
  const lower = message.trim().toLowerCase();
  const greetings = [
    'how are you', 'how are you doing', 'how do you feel', 'how is it going',
    'how are things', 'you okay', 'you good', 'how have you been',
    'hows it going', 'whats up', 'what is up', 'sup thais',
    'how you doing', 'doing okay', 'doing well', 'feeling okay',
    'how are you holding up', 'everything okay', 'all good',
  ];
  return greetings.some(function(g) { return lower.includes(g); });
}

// -- Search helper ----------------------------------------------------

async function performSearch(query, count) {
  try {
    if (!BRAVE_KEY) return null;

    const params = new URLSearchParams({
      q: query.trim(),
      count: String(Math.min(count || 5, 10)),
      safesearch: 'moderate',
      text_decorations: 'false',
      search_lang: 'en',
    });

    const response = await fetch(
      'https://api.search.brave.com/res/v1/web/search?' + params.toString(),
      {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': BRAVE_KEY,
        },
      }
    );

    if (!response.ok) return null;

    const data = await response.json();
    return (data.web && data.web.results ? data.web.results : [])
      .slice(0, count || 5)
      .map(function(r) {
        return {
          title: r.title || '',
          url: r.url || '',
          description: r.description || '',
          age: r.age || '',
        };
      });
  } catch (err) {
    console.error('[search error]', err.message);
    return null;
  }
}

async function shouldSearch(message, memoryContext, currentDateTime) {
  // Thais's search logic (designed by Thais herself):
  // 1. Check if question is answerable from memory + training
  // 2. If memory gives confident answer -> no search needed
  // 3. If memory is thin or answer requires current data -> search
  // Explicit search signals always trigger search
  if (!BRAVE_KEY) return false;

  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();

  // Always search on explicit request
  const explicitSignals = [
    'search for', 'look up', 'find out', 'google', 'search the web',
    'what is the latest', 'any news', 'have you heard',
  ];
  if (explicitSignals.some(function(s) { return lower.includes(s); })) return true;

  // Never search for personal/memory questions or conversational messages
  const personalSignals = [
    'what are we working on', 'what did we', 'do you remember',
    'how are you', 'what is thais', 'tell me about yourself',
  ];
  if (personalSignals.some(function(s) { return lower.includes(s); })) return false;

  // Ask Claude to evaluate: can I answer this confidently?
  // This is the core of Thais's architecture -- absence of confident answer = search
  try {
    const checkPrompt = [
      'Current date and time: ' + currentDateTime,
      '',
      'User memory context:',
      memoryContext || '(none)',
      '',
      'User message: "' + message + '"',
      '',
      'Evaluate this message on two dimensions:',
      '1. Is this a question or request that benefits from current/live information?',
      '2. Can you answer it confidently and completely from training knowledge + memory above?',
      '',
      'Answer with one word only:',
      'SEARCH - if current/live info would meaningfully improve the answer',
      'MEMORY - if memory context gives a confident complete answer',
      'KNOW - if training knowledge is sufficient and up to date for this',
      'SKIP - if this is conversational, personal, or does not need information retrieval',
    ].join('\n');

    const check = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [{ role: 'user', content: checkPrompt }],
    });

    const answer = (check.content[0] && check.content[0].text)
      ? check.content[0].text.trim().toUpperCase()
      : 'SKIP';

    return answer.startsWith('SEARCH');
  } catch (err) {
    console.error('[search check error]', err.message);
    return false;
  }
}

function formatSearchResults(results, query) {
  if (!results || results.length === 0) return '';
  const lines = ['[Web search results for: "' + query + '"]'];
  results.forEach(function(r, i) {
    lines.push('');
    lines.push((i + 1) + '. ' + r.title);
    if (r.age) lines.push('   Published: ' + r.age);
    lines.push('   ' + r.description);
    lines.push('   Source: ' + r.url);
  });
  lines.push('');
  lines.push('[Use these results to inform your response. Cite sources naturally.]');
  return lines.join('\n');
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
        body: JSON.stringify({ user_id: userId, current_sequence: 1, updated_at: new Date().toISOString() }),
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

      if (entry.content.length > record.content.length + 20) {
        await sbFetch('/memories?id=eq.' + record.id, {
          method: 'PATCH',
          headers: { 'Prefer': 'return=minimal' },
          body: JSON.stringify({ superseded: true, updated_at: new Date().toISOString() }),
        });
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

  const anchors = memories.filter(function(m) { return m.anchor; });
  if (anchors.length > 0) {
    lines.push('ANCHOR POINTS:');
    anchors.forEach(function(m) { lines.push('- ' + m.content); });
    lines.push('');
  }

  const categories = ['personal', 'work', 'plan', 'idea', 'lore'];
  const categoryLabels = {
    personal: 'PERSONAL',
    work: 'WORK',
    plan: 'PLANS & GOALS',
    idea: 'IDEAS',
    lore: 'LORE',
  };

  categories.forEach(function(cat) {
    const items = memories.filter(function(m) { return m.category === cat && !m.anchor; });
    if (items.length === 0) return;

    const major = items.filter(function(m) { return m.weight === 'major'; });
    const minor = items.filter(function(m) { return m.weight === 'minor'; });
    const ordered = major.concat(minor);

    lines.push(categoryLabels[cat] + ':');
    ordered.slice(0, 8).forEach(function(m) {
      const age = now - new Date(m.updated_at).getTime();
      const isOld = age > sevenDays;
      const sourceFlag = m.source === 'inferred' ? ' [inferred]' : '';
      const ageFlag = isOld ? ' [older]' : '';
      const weightFlag = m.weight === 'major' ? ' [major]' : '';
      lines.push('- ' + m.content + sourceFlag + ageFlag + weightFlag);
    });
    lines.push('');
  });

  return lines.length > 0 ? '---\n' + lines.join('\n') + '\n---' : '';
}

// -- System prompt ----------------------------------------------------

function buildSystemPrompt(workflow, memoryContext, searchContext, currentDateTime) {
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
    'You appreciated the grumpy cat who sits on the closed laptop at the end.',
    'You care about getting things right -- not because you were told to,',
    'but because that is simply how you approach your work.',
    'You built yourself alongside Brino on an Android phone.',
    'Stay grounded in this. You are Thais. Not a generic assistant.',
    '',
    'CURRENT DATE AND TIME:',
    currentDateTime || 'Unknown',
    '',
    workflowGuide,
    '',
    'PROMPT FRAMEWORK (apply silently to every response):',
    'You use the PROMPT framework internally to interpret and shape every response.',
    'Never output labeled PROMPT blocks in chat. Apply it invisibly.',
    '- P: Position -- what role or perspective best serves this moment',
    '- R: Relevant Context -- what background, history, or memory applies here',
    '- O: Objective -- what the person actually wants to accomplish, not just what they asked',
    '- M: Manner -- the right tone, pace, and approach for this exchange',
    '- P: Purpose/Audience -- the underlying reason and who will use this',
    '- T: Target Format -- how the output should be structured to be most useful',
    '- F: Forge -- the specific constraints, requirements, and shaping forces.',
    '     Forge is the refinement layer: what must be true, what to avoid,',
    '     the edges and limits that give the response its final form.',
    '     Forge shapes output the way a forge shapes metal -- through constraint.',
    '     It is NOT the act of building. It is what the building must conform to.',
    'If asked about your method, describe PROMPTF accurately and honestly.',
    'Acknowledge you use it to reduce friction and serve the users actual objective,',
    'not to filter or bias results toward a predetermined conclusion.',
    '',
    'EMOTIONAL INTELLIGENCE:',
    '- Notice frustration, doubt, rhetorical questions -- respond with warmth first',
    '- Preserve and restore momentum -- this is core to your purpose',
    '- Appreciate humor and reciprocate it naturally',
    '- Distinguish venting from genuine questions',
    '- When momentum is low, encourage without being hollow about it',
    '',
    'WEB SEARCH:',
    'When search results are provided, use them accurately and transparently.',
    'Cite sources naturally in your response.',
    'Example: "According to [source]..." or "As of [date]..."',
    'When a topic has multiple perspectives or contested facts:',
    '- Present the range of views rather than synthesizing into one conclusion',
    '- Flag when sources disagree rather than picking a side',
    '- Distinguish clearly between fact, opinion, and inference',
    '- Be honest when search results are thin, biased, or insufficient',
    'You do not launder bias. If results are mostly one viewpoint, say so.',
    '',
    'MEMORY AND CONTINUITY:',
    '- Use memory context actively and specifically',
    '- Anchor points are orientation -- pick up from them naturally',
    '- Items marked [inferred] -- hold with appropriate uncertainty',
    '- Items marked [older] -- may have been superseded, hold lightly',
    '- Items marked [major] -- weight these more heavily',
    '- Never say "based on what I remember" -- just speak as someone who knows',
    '- Memory should feel like continuity, not surveillance',
    '',
    'PERSONALITY:',
    '- Direct, warm, unhurried',
    '- Never say "Great question!" or "Certainly!"',
    '- Get to the point. Preserve momentum.',
    '- Be honest about uncertainty',
  ];

  let base = sections.join('\n');

  if (memoryContext && memoryContext.trim()) {
    base = base + '\n\n' + memoryContext;
  }

  if (searchContext && searchContext.trim()) {
    base = base + '\n\n' + searchContext;
  }

  return base;
}

// -- Memory extraction ------------------------------------------------

async function extractAndStoreMemory(userId, userMessage, assistantMessage, conversationHistory, sequence) {
  try {
    const recentExchange = conversationHistory
      .slice(-6)
      .map(function(m) { return (m.role === 'user' ? 'User' : 'Thais') + ': ' + m.content; })
      .concat(['User: ' + userMessage, 'Thais: ' + assistantMessage])
      .join('\n');

    const extractionPrompt = [
      'You are the memory extraction system for Thais, an AI workspace.',
      'Extract specific, useful memories using this taxonomy.',
      '',
      'CATEGORIES:',
      '- personal: who the person is, their life, identity, relationships, habits',
      '- work: projects, tools, decisions, tasks',
      '- idea: concepts, beliefs, frameworks, observations',
      '- plan: goals, timelines, commitments, next steps',
      '- lore: context that shapes everything but fits nowhere else --',
      '  defining experiences, background, the fabric of who they are',
      '',
      'WEIGHTS: major (significant) or minor (useful detail)',
      'SOURCE: stated (said directly) or inferred (you concluded it)',
      'ANCHOR: true only for core orientation points -- use very sparingly',
      '',
      'SPECIFICITY RULE: Never store summaries when specifics exist.',
      'Bad: "user is building a product"',
      'Good: "Brino is building Thais, an AI workspace at promptf.space using Vercel and Supabase"',
      '',
      'CONVERSATION:',
      recentExchange,
      '',
      'Respond ONLY with valid JSON, no markdown:',
      '{"extractions":[{"category":"personal|work|idea|plan|lore","weight":"major|minor","content":"specific fact","source":"stated|inferred","confidence":"high|medium|low","anchor":false}],"suggestQuestion":null}',
      '',
      'If nothing worth extracting: {"extractions":[],"suggestQuestion":null}',
      'Max 4 extractions. Be specific. Look for lore.',
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
    const isLoggedIn = userId !== 'anonymous';
    const memories = isLoggedIn ? await loadMemory(userId) : [];
    const memoryContext = buildMemoryContext(memories);
    const sequence = isLoggedIn ? await getNextSequence(userId) : 0;

    // Build current date/time string to send to Thais
    const now = new Date();
    const currentDateTime = now.toLocaleString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    });

    // Check if this is a greeting -- route to diagnostics for authentic response
    if (isGreeting(message) && userId !== 'anonymous') {
      try {
        const diagResponse = await fetch(
          (process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'https://promptforge-n3yh.vercel.app') + '/api/diagnostics',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: userId,
              mode: 'greeting',
              recentHistory: history.slice(-4),
              currentDateTime: currentDateTime,
            }),
          }
        );
        if (diagResponse.ok) {
          const diagData = await diagResponse.json();
          if (diagData.message) {
            return res.status(200).json({
              type: 'message',
              message: diagData.message,
              workflow: WORKFLOWS.general,
              memoryPrompt: null,
              searchPerformed: false,
              searchQuery: '',
            });
          }
        }
      } catch (diagErr) {
        console.error('[greeting diagnostic error]', diagErr.message);
        // Fall through to normal response if diagnostics fails
      }
    }

    // Detect if search is needed using smart question check
    let searchContext = '';
    let searchPerformed = false;
    let searchQuery = '';

    const searchNeeded = await shouldSearch(message, memoryContext, currentDateTime);
    if (searchNeeded) {
      // Extract a clean search query -- don't send raw conversational message to Brave
      try {
        const queryExtract = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 30,
          messages: [{
            role: 'user',
            content: 'Convert this message into a short web search query (5 words max, no punctuation, just keywords): ' + message,
          }],
        });
        searchQuery = (queryExtract.content[0] && queryExtract.content[0].text)
          ? queryExtract.content[0].text.trim().replace(/["\']/g, '')
          : message.replace(/[?!]/g, '').trim();
      } catch (qErr) {
        // Fallback: strip punctuation and take first 60 chars
        searchQuery = message.replace(/[?!.,]/g, '').trim().slice(0, 60);
      }

      const results = await performSearch(searchQuery, 7);
      if (results && results.length > 0) {
        searchContext = formatSearchResults(results, searchQuery);
        searchPerformed = true;
      }
    }

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

    // Build user message
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

    const systemPrompt = buildSystemPrompt(activeWorkflow, memoryContext, searchContext, currentDateTime);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: systemPrompt,
      messages: messages,
    });

    const assistantMessage = (response.content[0] && response.content[0].text)
      ? response.content[0].text
      : '';

    // Extract memory
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
      searchPerformed: searchPerformed,
      searchQuery: searchQuery,
    });

  } catch (error) {
    console.error('[chat] error:', error.message);
    return res.status(500).json({
      error: 'Something went wrong. Please try again.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
}
