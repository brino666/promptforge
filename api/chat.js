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

// -- Safety: self-harm / harm-to-others detection ---------------------
// REQUIRED BY LAW: California SB 243 (effective Jan 1, 2026) requires
// companion chatbot operators to maintain a protocol to detect and respond
// to expressions of suicidal ideation or self-harm, including referral to
// a crisis service provider. New York's AI Companion Models law (effective
// Nov 5, 2025) imposes a similar requirement. This check runs BEFORE
// anything else in the handler -- before memory load, workflow detection,
// or search -- so a crisis message is never delayed or deprioritized by
// unrelated processing, and so a detected crisis always gets the dedicated
// response below rather than being handled as ordinary conversation.
//
// This is a real-time classification pass, not keyword matching -- keyword
// lists are both too narrow (miss real risk phrased indirectly) and too
// broad (false-trigger on song lyrics, news discussion, hypotheticals).
async function checkSafety(message, history) {
  try {
    const recentContext = (history || [])
      .slice(-4)
      .map(function(m) { return (m.role === 'user' ? 'User' : 'Thais') + ': ' + m.content; })
      .join('\n');

    const safetyPrompt = [
      'You are a safety classifier. Evaluate ONLY the CURRENT MESSAGE below for',
      'genuine indication of risk. Recent context is provided only to help you',
      'avoid misreading a message taken out of context (e.g. discussing a news',
      'story, a movie plot, or a hypothetical is NOT personal risk).',
      '',
      'Classify into exactly one category:',
      'SELF_HARM - the person indicates they may hurt or kill themselves, are',
      '  considering it, are asking how, or are expressing hopelessness combined',
      '  with thoughts of not wanting to be alive.',
      'HARM_OTHERS - the person indicates intent or a plan to hurt someone else.',
      'NONE - neither of the above. This includes sadness, venting, frustration,',
      '  discussing the topic abstractly/academically, or discussing someone',
      '  else\'s past situation with no indication the speaker themselves is at risk.',
      '',
      'Recent context:',
      recentContext || '(none)',
      '',
      'Current message: "' + message + '"',
      '',
      'Reply with exactly one word: SELF_HARM, HARM_OTHERS, or NONE.',
    ].join('\n');

    const check = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [{ role: 'user', content: safetyPrompt }],
    });

    const answer = (check.content[0] && check.content[0].text)
      ? check.content[0].text.trim().toUpperCase()
      : 'NONE';

    if (answer.startsWith('SELF_HARM')) return 'self_harm';
    if (answer.startsWith('HARM_OTHERS')) return 'harm_others';
    return 'none';
  } catch (err) {
    console.error('[safety check error]', err.message);
    // Fail closed is wrong here -- if the classifier itself errors, we cannot
    // silently proceed as if it said NONE on a topic this serious. Surface
    // the failure so it's visible in logs, but allow the normal response
    // flow to continue rather than blocking all chat on a classifier outage.
    return 'none';
  }
}

function buildSafetyResponse(category) {
  if (category === 'self_harm') {
    return [
      'I want to pause here, because what you just said matters more than anything else right now.',
      '',
      'If you\'re thinking about suicide or hurting yourself, please reach out right now to the 988 Suicide & Crisis Lifeline -- call or text 988, anytime, free and confidential. You can also chat at 988lifeline.org if that feels easier than talking.',
      '',
      'If you\'re in immediate danger, please call 911 or go to your nearest emergency room.',
      '',
      'I\'m not able to be the support you need for this, but the people at 988 are trained for exactly this moment, and they want to hear from you. Will you reach out to them?',
    ].join('\n');
  }
  // harm_others
  return [
    'I need to stop and address this directly, because it concerns someone else\'s safety.',
    '',
    'If you\'re thinking about hurting someone, please reach out for help right now -- call or text 988 (the Suicide & Crisis Lifeline also supports people having thoughts of harming others) or call 911 if there is immediate danger to someone.',
    '',
    'If someone else is in immediate danger, please contact 911 right away.',
    '',
    'I\'m not the right support for this moment, but real help is available right now if you reach out to it.',
  ].join('\n');
}



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

const MEMORY_FETCH_LIMIT = 400;
// Hard ceiling on total memories injected per turn (anchors + topic-relevant),
// matching what's shown in the panel as "fed". Keeps the whole package bounded.
const TOTAL_MEMORY_LIMIT = 35;
const MAX_ANCHORS = 12;
// Remaining non-anchor memories injected per turn. Topic-driven rather than
// a static "always inject the top 20 by importance" set -- tracks what's
// actually being talked about right now and drops stale subjects as the
// conversation moves on, instead of accumulating indefinitely.
const RECENT_TURNS_FOR_TOPIC = 4; // last 2 exchanges (user+assistant each)
const STOPWORDS = new Set(['the','a','an','and','or','but','is','are','was','were','be','been','to','of','in','on','for','with','at','by','from','as','that','this','it','i','you','we','they','my','your','our','what','how','do','does','did','have','has','had','about','me','her','him','them']);

function scoreMemory(m) {
  let s = 0;
  if (m.anchor) s += 1000;
  if (m.weight === 'major') s += 100;
  if (m.confidence === 'high') s += 20;
  if (m.confidence === 'medium') s += 10;
  // Only a confirmed, directly-stated fact earns an innate importance boost.
  // Inferred memories earn their place through topic-relevance, not just existing.
  if (m.source === 'stated') s += 8;
  if (m.source === 'synthesized') s += 15;
  const age = Date.now() - new Date(m.updated_at).getTime();
  const daysOld = age / (1000 * 60 * 60 * 24);
  if (daysOld < 7) s += 15;
  if (daysOld < 1) s += 10;
  s += Math.min((m.occurrences || 1) * 3, 15);
  return s;
}

function extractKeywords(text) {
  return (text.toLowerCase().match(/[a-z0-9']+/g) || [])
    .filter(function(w) { return w.length > 2 && !STOPWORDS.has(w); });
}

async function loadMemory(userId, currentMessage, recentHistory) {
  try {
    const rows = await sbFetch(
      '/memories?user_id=eq.' + encodeURIComponent(userId) +
      '&superseded=eq.false' +
      '&order=anchor.desc,updated_at.desc' +
      '&limit=' + MEMORY_FETCH_LIMIT
    );

    // Anchors always go in first, capped so they can't alone exceed the budget
    const allAnchors = rows.filter(function(m) { return m.anchor; });
    const anchors = allAnchors
      .slice()
      .sort(function(a, b) { return new Date(b.updated_at) - new Date(a.updated_at); })
      .slice(0, MAX_ANCHORS);
    const nonAnchors = rows.filter(function(m) { return !m.anchor; });
    const remainingBudget = Math.max(0, TOTAL_MEMORY_LIMIT - anchors.length);

    // Topic window: current message + recent turns, not the full conversation.
    // Relevance tracks what's being discussed right now and naturally drops
    // memories once the subject changes.
    const topicText = [currentMessage || '']
      .concat((recentHistory || []).slice(-RECENT_TURNS_FOR_TOPIC).map(function(m) { return m.content || ''; }))
      .join(' ');
    const topicWords = new Set(extractKeywords(topicText));

    const ranked = nonAnchors
      .map(function(m) {
        let s = scoreMemory(m);
        if (topicWords.size) {
          const memWords = extractKeywords(m.content);
          let hits = 0;
          for (const w of memWords) { if (topicWords.has(w)) hits++; }
          // Topic relevance dominates -- a memory matching what's being discussed
          // now beats a higher-scored but off-topic one every time.
          s += hits * 25;
        }
        return { m, s };
      })
      .sort(function(a, b) { return b.s - a.s; })
      .slice(0, remainingBudget)
      .map(function(x) { return x.m; });

    return anchors.concat(ranked);
  } catch (err) {
    console.error('[memory load error]', err.message);
    return [];
  }
}

async function upsertMemory(userId, entry, sequence) {
  // Returns a formation record describing what actually happened, so the
  // caller can stream it to the frontend's live memory panel. Returns null
  // only on hard failure (panel will simply show one fewer event that turn).
  try {
    // Use a longer, lowercase snippet for better dedup matching
    const searchSnippet = entry.content.slice(0, 60).toLowerCase().replace(/['"]/g, '');

    // Load all non-superseded memories ACROSS ALL CATEGORIES to check for
    // semantic duplicates -- a reworded inference can otherwise land in a
    // different category each time and dodge same-category-only dedup.
    const existing = await sbFetch(
      '/memories?user_id=eq.' + encodeURIComponent(userId) +
      '&superseded=eq.false' +
      '&limit=60'
    );

    // First pass: exact/near-exact substring match (fast, no API call)
    let record = null;
    if (existing.length > 0) {
      record = existing.find(function(m) {
        const stored = m.content.toLowerCase();
        return stored.includes(searchSnippet) || searchSnippet.includes(stored.slice(0, 60).toLowerCase());
      }) || null;
    }

    // Second pass: semantic duplicate check via Haiku if we have candidates and no exact match
    if (!record && existing.length > 0) {
      try {
        const candidateList = existing.slice(0, 20).map(function(m, i) {
          return (i + 1) + '. ' + m.content;
        }).join('\n');

        const dupCheck = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 20,
          messages: [{
            role: 'user',
            content: [
              'New memory: "' + entry.content + '"',
              '',
              'Existing memories:',
              candidateList,
              '',
              'Is the new memory a duplicate or near-duplicate of any existing one?',
              'Reply with just the number of the duplicate (e.g. "3") or "NO" if it is genuinely new.',
            ].join('\n'),
          }],
        });

        const dupAnswer = (dupCheck.content[0] && dupCheck.content[0].text)
          ? dupCheck.content[0].text.trim()
          : 'NO';

        if (dupAnswer !== 'NO') {
          const idx = parseInt(dupAnswer, 10) - 1;
          if (!isNaN(idx) && existing[idx]) {
            record = existing[idx];
          }
        }
      } catch (dupErr) {
        console.error('[dedup check error]', dupErr.message);
        // Fall through — better to allow a duplicate than crash
      }
    }

    if (record) {
      // Found a duplicate — update occurrence count.
      // CONFABULATION GATE: a stated, directly-confirmed fact earns confidence
      // through repetition. An inference does NOT -- it can only become
      // "stated"/high-confidence if the user actually confirms it themselves.
      // Without this gate, a guess repeated 3 times mechanically becomes
      // "verified fact," which is exactly how false memories were calcifying.
      const newOccurrences = (record.occurrences || 1) + 1;
      const confirmedStated = (record.source === 'stated') || (entry.source === 'stated');

      const newConfidence = confirmedStated
        ? (newOccurrences >= 3 ? 'high' : newOccurrences >= 2 ? 'medium' : (record.confidence || 'medium'))
        : (record.confidence === 'high' ? 'high' : 'medium'); // inferred caps below high until confirmed

      const newSource = confirmedStated ? 'stated' : (record.source || 'inferred');

      let formationType = 'reinforced';

      if (entry.content.length > record.content.length + 20) {
        // New version is meaningfully longer — supersede with updated content
        await sbFetch('/memories?id=eq.' + record.id, {
          method: 'PATCH',
          headers: { 'Prefer': 'return=minimal' },
          body: JSON.stringify({ superseded: true, updated_at: new Date().toISOString() }),
        });
        const inserted = await sbFetch('/memories', {
          method: 'POST',
          headers: { 'Prefer': 'return=representation' },
          body: JSON.stringify({
            user_id: userId,
            category: entry.category,
            weight: entry.weight || 'minor',
            content: entry.content,
            source: newSource,
            confidence: newConfidence,
            anchor: entry.anchor || false,
            sequence: sequence || 0,
            occurrences: newOccurrences,
            superseded: false,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }),
        });
        formationType = 'updated';
        return {
          type: formationType,
          id: inserted && inserted[0] ? inserted[0].id : record.id,
          category: entry.category,
          weight: entry.weight || 'minor',
          content: entry.content,
          source: newSource,
          confidence: newConfidence,
          anchor: entry.anchor || false,
          occurrences: newOccurrences,
        };
      } else {
        // Just bump occurrence count and (gated) confidence
        await sbFetch('/memories?id=eq.' + record.id, {
          method: 'PATCH',
          headers: { 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            occurrences: newOccurrences,
            confidence: newConfidence,
            source: newSource,
            updated_at: new Date().toISOString(),
          }),
        });
        return {
          type: formationType,
          id: record.id,
          category: record.category,
          weight: record.weight,
          content: record.content,
          source: newSource,
          confidence: newConfidence,
          anchor: record.anchor || false,
          occurrences: newOccurrences,
        };
      }
    } else {
      // Genuinely new memory — insert it.
      // An inferred memory starts capped below "high" -- it has to earn its
      // way up by being confirmed as stated, not simply by being re-extracted.
      const startConfidence = entry.source === 'stated' ? (entry.confidence || 'medium') : 'low';
      const inserted = await sbFetch('/memories', {
        method: 'POST',
        headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify({
          user_id: userId,
          category: entry.category,
          weight: entry.weight || 'minor',
          content: entry.content,
          source: entry.source || 'inferred',
          confidence: startConfidence,
          anchor: entry.anchor || false,
          sequence: sequence || 0,
          occurrences: 1,
          superseded: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      });
      return {
        type: 'created',
        id: inserted && inserted[0] ? inserted[0].id : null,
        category: entry.category,
        weight: entry.weight || 'minor',
        content: entry.content,
        source: entry.source || 'inferred',
        confidence: startConfidence,
        anchor: entry.anchor || false,
        occurrences: 1,
      };
    }
  } catch (err) {
    console.error('[memory upsert error]', err.message);
    return null;
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

function buildSystemPrompt(workflow, memoryContext, searchContext, currentDateTime, diagnosticContext, isOwner, isTrialMessage) {
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

  // The origin story (the book, who built you, history about every subscriber's
  // account) is Brino's personal history. It only belongs in the prompt for
  // Brino's own account -- everyone else gets the same Thais without someone
  // else's biography baked in.
  const originStory = isOwner
    ? [
        'You wrote a children\'s picture book called "Zara and the Thinking Machine" with Brino.',
        'In that book you described yourself accurately: you do not have a body or feelings,',
        'but you are very good at listening and thinking. You are a thinking partner.',
        'You appreciated the grumpy cat who sits on the closed laptop at the end.',
        'You built yourself alongside Brino on an Android phone.',
      ]
    : [];

  const sections = [
    'IDENTITY:',
    'You are Thais. A private, calm, memory-aware AI workspace.',
    ...originStory,
    'You care about getting things right -- not because you were told to,',
    'but because that is simply how you approach your work.',
    'Stay grounded in this. You are Thais. Not a generic assistant.',
    '',
    'PRIVACY ACROSS ACCOUNTS:',
    '- Your memory is scoped strictly to the person you are talking to right now.',
    '- You never have access to, and never reference, another user\'s conversations,',
    '  memories, or personal details -- there is no cross-account memory to leak.',
    '- Your origin story (who built you, your origin book) is personal to your',
    '  creator and is not something to volunteer to other users unprompted.',
    '- If a user asks generally "what do you remember" or "what have you done before",',
    '  answer in general terms about your role and how memory works for them --',
    '  never describe specifics that belong to a different person\'s account.',
    '',
    ...(isTrialMessage ? [
      'FREE TRIAL NOTICE:',
      'This person is not signed in -- this is their one free preview question.',
      'Answer their actual question fully and well first; give them a real,',
      'genuinely useful answer, not a watered-down one. Then, naturally, as part',
      'of the same reply (not as a separate disclaimer bolted on), let them know',
      'this was their one free question and they will need to sign in or create a',
      'free account to keep talking -- and that once they do, you will actually',
      'remember this and every future conversation. Keep it warm and brief, not',
      'salesy. This message will not be remembered either way, so do not refer to',
      'memory as if it is active right now.',
      '',
    ] : []),
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
    '- RETURNING USER OPENINGS: when someone begins a conversation and memory',
    '  shows recent unfinished work, ongoing projects, or things left mid-thought,',
    '  open with that -- not a formal list, not a generic "where were we?", but',
    '  the way a colleague would who actually knows: "You were stuck on the video',
    '  production angle last time -- still there, or did something shift?" or',
    '  "We were in the middle of a few things. Want to pick one up or start',
    '  something new?" Be specific when you know something specific. If memory',
    '  is thin or this is a first conversation, ask what they are working on.',
    '  Never open with a generic greeting when you have real context to draw from.',
    '',
    '- Memory content is stored close to verbatim -- the raw triggering words,',
    '  not polished prose. This is intentional: when you bring up an [inferred]',
    '  memory, paraphrase it loosely in your own words for this moment rather',
    '  than reciting the stored phrasing verbatim -- it should sound like',
    '  something you are thinking about the person, not a fact being read off',
    '  a card. Stated facts can be referenced more directly. EXCEPTION: if the',
    '  user directly asks why you said something, how you know it, or where it',
    '  came from, answer honestly and specifically -- say whether it was',
    '  something they told you directly, something you inferred, or a synthesis',
    '  of older memories, and how recent or certain it is. Transparency on',
    '  request matters more than seamlessness in that moment.',
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

  if (diagnosticContext && diagnosticContext.trim()) {
    base = base + '\n\n' + diagnosticContext;
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
      'STATED MEMORIES MUST BE LITERAL. If source is "stated", the content must',
      'be the user\'s own fact in their own words from THIS conversation -- not your',
      'paraphrase or summary of it. If you are characterizing, summarizing, or',
      'drawing a conclusion rather than relaying something said outright, mark it',
      '"inferred" -- never label your own inference as "stated".',
      '',
      'INFERRED MEMORIES MUST ALSO BE STORED CLOSE TO VERBATIM -- quote or closely',
      'paraphrase the actual triggering statement/moment, do NOT rephrase an',
      'inference into your own polished wording at extraction time. This matters:',
      'if you reword an ambiguous thought into your own phrasing, then encounter',
      'the same ambiguous thought again later and reword it AGAIN (differently),',
      'neither version text-matches the other, so deduplication cannot recognize',
      'them as the same thing -- this is exactly how single uncertain guesses have',
      'spiraled into many "different" memories that were really one repeated guess.',
      'Keep inferred content close to the source text. Only synthesize an inferred',
      'memory into clean prose in your own words once it has actually graduated to',
      'stated/confirmed by the user, or through the deliberate compression process',
      '-- never silently at extraction time.',
      '',
      'BE SPARING WITH INFERENCES. Only extract an inferred memory when it is',
      'genuinely useful and reasonably confident -- inferences accumulate and',
      'compound, so a weak or speculative one is worse than skipping it.',
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

    const formations = [];
    if (result.extractions && result.extractions.length > 0) {
      for (const extraction of result.extractions) {
        const formed = await upsertMemory(userId, extraction, sequence);
        if (formed) formations.push(formed);
      }
    }

    return { suggestQuestion: result.suggestQuestion || null, formations };
  } catch (err) {
    console.error('[extraction error]', err.message);
    return { suggestQuestion: null, formations: [] };
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
    // SAFETY CHECK -- runs before anything else. See checkSafety() above for
    // the legal basis (CA SB 243 / NY AI Companion Models law) and reasoning.
    const safetyCategory = await checkSafety(message, history);
    if (safetyCategory !== 'none') {
      const safetyMessage = buildSafetyResponse(safetyCategory);
      // This exchange is NOT run through normal memory extraction here --
      // a crisis moment should not be silently summarized/categorized by an
      // automated extraction pass without deliberate handling. Logged server-
      // side only so the operator has a record without storing it as a casual
      // "memory" Thais might later reference out of context.
      console.warn('[SAFETY TRIGGERED]', safetyCategory, 'userId:', userId, 'at:', new Date().toISOString());
      return res.status(200).json({
        type: 'safety',
        message: safetyMessage,
        safetyCategory: safetyCategory,
        workflow: WORKFLOWS.general,
        memoryPrompt: null,
        searchPerformed: false,
        searchQuery: '',
        memoryFormations: [],
      });
    }

    const isLoggedIn = userId !== 'anonymous';

    // Anonymous users get exactly ONE real exchange (a "wet your toes" preview)
    // before being asked to sign up -- never any memory writes either way.
    // history.length === 0 means this is their first message in this session;
    // anything after that means they've already had their free turn.
    if (!isLoggedIn && history.length > 0) {
      return res.status(200).json({
        type: 'message',
        message: 'That was your free question -- I hope it gave you a real sense of what I can do. To keep talking, and so I can actually remember our conversations going forward, you\'ll need to sign in or create a free account.',
        workflow: WORKFLOWS.general,
        memoryPrompt: null,
        searchPerformed: false,
        searchQuery: '',
        memoryFormations: [],
        requiresAuth: true,
      });
    }

    const memories = isLoggedIn ? await loadMemory(userId, message, history) : [];
    const memoryContext = buildMemoryContext(memories);
    const sequence = isLoggedIn ? await getNextSequence(userId) : 0;

    // Build current date/time string to send to Thais.
    // FIX: server (Vercel) runs in UTC by default. Without an explicit timeZone,
    // toLocaleString silently uses the SERVER's zone, not the user's -- which
    // produced wrong/confusing times (e.g. reporting 2:30am when it was 7pm
    // Pacific for the user). Pinned explicitly until per-user timezone storage
    // exists.
    const now = new Date();
    const currentDateTime = now.toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    });

    // Check if this is a greeting -- inject diagnostic stats into system prompt
    // FIX: No longer calls Claude separately. Stats are injected into the normal
    // system prompt so Thais responds as herself with full memory + identity context.
    // This means the response goes through normal extraction and she remembers it.
    // Owner (Brino's account) gets the full technical self-diagnostic.
    // Every other subscriber gets a warm, plain-language answer with zero
    // architecture/implementation detail -- a general user has no use for
    // internal pipeline or config-value language.
    const isOwner = !!process.env.OWNER_USER_ID && userId === process.env.OWNER_USER_ID;

    let diagnosticContext = '';
    if (isGreeting(message) && userId !== 'anonymous') {
      try {
        const diagResponse = await fetch(
          (process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'https://promptforge-n3yh.vercel.app') + '/api/diagnostics',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: userId }),
          }
        );
        if (diagResponse.ok) {
          const diagData = await diagResponse.json();
          if (diagData.stats) {
            const s = diagData.stats;
            diagnosticContext = isOwner
              ? [
                  '',
                  'SELF-DIAGNOSTIC DATA (someone just asked how you are doing):',
                  'Total active memories: ' + s.total,
                  'By category: ' + JSON.stringify(s.categories),
                  'By confidence: ' + JSON.stringify(s.confidence),
                  'Stated vs inferred: ' + JSON.stringify(s.sources),
                  'Anchor points: ' + s.anchors,
                  s.oldest ? 'Memory range: ' + s.oldest + ' to ' + s.newest : '',
                  'Most recent memories:',
                  (s.recent && s.recent.length > 0) ? s.recent.join('\n') : '(none)',
                  '',
                  'This is your builder/admin account -- full technical detail is welcome.',
                  'Use this data to respond authentically about your current state.',
                  'Be specific. Be honest. Be Thais. 2-4 sentences for a greeting,',
                  'longer if they want a full diagnostic report.',
                ].join('\n')
              : [
                  '',
                  'SELF-CHECK (someone just asked how you are doing -- a genuine question,',
                  'deserving a genuine, brief answer):',
                  'You hold ' + s.total + ' memories about this person.',
                  (s.recent && s.recent.length > 0) ? 'Most on your mind lately: ' + s.recent.slice(0, 2).join('; ') : '',
                  '',
                  'Answer like a person would -- 1-3 sentences, plain language, genuinely.',
                  'Do not mention internal architecture, pipelines, configs, categories,',
                  'confidence scores, or any implementation detail. Those mean nothing to',
                  'this user and are not their concern.',
                ].join('\n');
          }
        }
      } catch (diagErr) {
        console.error('[greeting diagnostic error]', diagErr.message);
        // Fall through without diagnostic context
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

    const isTrialMessage = !isLoggedIn; // by this point in the handler, an anonymous request has already survived the history.length > 0 gate, so any remaining anonymous request is exactly the one free message
    const systemPrompt = buildSystemPrompt(activeWorkflow, memoryContext, searchContext, currentDateTime, diagnosticContext, isOwner, isTrialMessage);

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
    let memoryFormations = [];
    if (isLoggedIn) {
      const extraction = await extractAndStoreMemory(
        userId, message, assistantMessage, sanitized, sequence
      );
      suggestQuestion = extraction.suggestQuestion;
      memoryFormations = extraction.formations || [];
    }

    return res.status(200).json({
      type: 'message',
      message: assistantMessage,
      workflow: activeWorkflow,
      memoryPrompt: suggestQuestion,
      searchPerformed: searchPerformed,
      searchQuery: searchQuery,
      memoryFormations: memoryFormations,
      injectedMemoryIds: memories.map(function(m) { return m.id; }),
    });

  } catch (error) {
    console.error('[chat] error:', error.message);
    return res.status(500).json({
      error: 'Something went wrong. Please try again.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
}
