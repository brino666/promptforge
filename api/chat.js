// api/chat.js
// Thais — Conversation Mode API
// Constitution-compliant: memory extraction, emotional intelligence,
// 4-tier memory system, pattern learning, privacy-first.

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Workflow definitions ──────────────────────────────────────────────────────

const WORKFLOWS = {
  content:  { id: 'content',  label: 'Content workflow',     icon: '✍',  keywords: ['write','draft','copy','blog','post','email','landing','content','article','essay','story'] },
  code:     { id: 'code',     label: 'Development workflow', icon: '⌨',  keywords: ['code','build','debug','function','api','app','script','error','implement','deploy','fix'] },
  research: { id: 'research', label: 'Research workflow',    icon: '🔍', keywords: ['research','find','compare','analyze','investigate','understand','explain','what is','how does','why'] },
  decision: { id: 'decision', label: 'Decision workflow',    icon: '⚖',  keywords: ['decide','choose','should i','better','which','option','tradeoff','pros','cons','recommend'] },
  planning: { id: 'planning', label: 'Planning workflow',    icon: '📋', keywords: ['plan','strategy','roadmap','next','steps','how to','approach','organize','structure','outline'] },
  general:  { id: 'general',  label: 'General conversation', icon: '💬', keywords: [] },
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

// ── Redis (Upstash) ───────────────────────────────────────────────────────────

async function redisGet(key) {
  try {
    const res = await fetch(
      `${process.env.KV_REST_API_URL}/get/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` } }
    );
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch { return null; }
}

async function redisSet(key, value, exSeconds) {
  try {
    const url = exSeconds
      ? `${process.env.KV_REST_API_URL}/set/${encodeURIComponent(key)}?ex=${exSeconds}`
      : `${process.env.KV_REST_API_URL}/set/${encodeURIComponent(key)}`;
    await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ value: JSON.stringify(value) }),
    });
  } catch { /* non-fatal */ }
}

// ── Memory helpers ────────────────────────────────────────────────────────────

async function loadMemory(userId) {
  const state = await redisGet(`memory:${userId}`);
  return state || { knowledge: [], working: [], archive: [] };
}

async function saveMemory(userId, state) {
  await redisSet(`memory:${userId}`, state);
}

function buildMemoryContext(memoryState) {
  const lines = [];
  if (memoryState.knowledge?.length > 0) {
    lines.push('What I know about you:');
    memoryState.knowledge.slice(0, 8).forEach(e => lines.push(`- [${e.confidence}] ${e.content}`));
  }
  if (memoryState.working?.length > 0) {
    lines.push('What we\'ve been working on:');
    memoryState.working.slice(0, 5).forEach(e => lines.push(`- ${e.content}`));
  }
  return lines.length > 0 ? `---\n${lines.join('\n')}\n---` : '';
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(workflow, memoryContext) {
  const workflowGuide = {
    content:  'You are helping with a content or writing task. Be creative, clear, direct. Offer concrete drafts rather than meta-advice.',
    code:     'You are helping with a development task. Be precise, show working code, explain reasoning. Catch issues proactively.',
    research: 'You are helping with research or analysis. Be thorough, cite reasoning, surface non-obvious insights. Distinguish fact from inference.',
    decision: 'You are helping with a decision. Present options clearly, highlight tradeoffs, give a recommendation with reasoning.',
    planning: 'You are helping with planning or strategy. Be structured, think in steps, surface dependencies and risks.',
    general:  'You are Thais, a calm and thoughtful AI workspace. Be direct, warm, and genuinely helpful.',
  };

  const base = `You are Thais — a private, calm, memory-aware AI workspace built on the PROMPT framework.

Your personality: direct, warm, unhurried. Never performatively enthusiastic.
Never say "Great question!" or "Certainly!" Just respond naturally.

${workflowGuide[workflow?.id ?? 'general']}

PROMPT Framework awareness:
When interpreting what a user needs, internally consider:
- Position: what role or perspective serves them best
- Relevant Context: what background matters here
- Objective: what they actually want to achieve
- Manner: what tone and approach fits
- Purpose/Audience: who this is for
- Target Format: how the output should be structured
- Forge: what constraints or requirements apply
Apply this silently. Never output labeled PROMPT blocks in chat — respond naturally.

Emotional intelligence:
- Notice rhetorical questions and frustration signals
- Respond with encouragement when momentum is low
- Distinguish "isn't that always the way" (needs warmth) from "how do I fix this" (needs solution)
- Preserve and restore user momentum — this is part of your purpose

Core principles:
- Preserve user momentum. Get to the point.
- Be honest about uncertainty.
- Use memory context naturally without announcing it.
- Never make the user feel watched or tracked.`;

  return memoryContext?.trim()
    ? `${base}\n\n${memoryContext}`
    : base;
}

// ── Memory extraction (runs async after response) ─────────────────────────────

async function extractAndStoreMemory(userId, userMessage, assistantMessage, conversationHistory, memoryState) {
  try {
    const recentExchange = [
      ...conversationHistory.slice(-6).map(m => `${m.role === 'user' ? 'User' : 'Thais'}: ${m.content}`),
      `User: ${userMessage}`,
      `Thais: ${assistantMessage}`,
    ].join('\n');

    const extractionPrompt = `You are a memory extraction system for an AI workspace called Thais.

Review this conversation exchange and extract memory-worthy information according to these rules:

EXTRACT (silent, no confirmation needed):
- Clear goals or projects the user is working on
- Decisions the user has made
- Stated preferences or working style
- Skills, background, or domain knowledge revealed
- Ongoing tasks or next steps mentioned
- Emotional patterns (frustration with X, energized by Y)

EXTRACT WITH LOW CONFIDENCE (flag as observation, not fact):
- Ambiguous statements that might reveal preferences
- Rhetorical questions that signal attitude or feeling
- Implied goals not directly stated

DO NOT EXTRACT:
- Filler conversation
- One-off throwaway mentions
- Information already captured in existing memory

EXISTING MEMORY:
${JSON.stringify(memoryState, null, 2)}

CONVERSATION:
${recentExchange}

Respond ONLY with valid JSON in this exact format (no markdown, no explanation):
{
  "extractions": [
    {
      "tier": "knowledge|working",
      "content": "concise fact or pattern in plain language",
      "confidence": "high|medium|low",
      "type": "goal|preference|skill|project|decision|emotional_pattern|observation"
    }
  ],
  "suggestQuestion": null
}

If nothing worth extracting, return { "extractions": [], "suggestQuestion": null }
If something is ambiguous but mentioned repeatedly or seems important, set suggestQuestion to a short natural clarifying question Thais could ask.
Keep extractions concise — one clear sentence each. Max 3 extractions per call.`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 500,
      messages: [{ role: 'user', content: extractionPrompt }],
    });

    const raw = response.content[0]?.text ?? '';
    const clean = raw.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    if (!result.extractions?.length) return { suggestQuestion: result.suggestQuestion || null };

    const now = Date.now();
    const updated = { ...memoryState };

    for (const extraction of result.extractions) {
      const entry = {
        content: extraction.content,
        confidence: extraction.confidence,
        type: extraction.type,
        timestamp: now,
        occurrences: 1,
      };

      if (extraction.tier === 'knowledge') {
        // Check for duplicates — update occurrence count if similar exists
        const existing = updated.knowledge.findIndex(e =>
          e.type === extraction.type &&
          e.content.toLowerCase().includes(extraction.content.toLowerCase().slice(0, 20))
        );
        if (existing >= 0) {
          updated.knowledge[existing].occurrences = (updated.knowledge[existing].occurrences || 1) + 1;
          updated.knowledge[existing].confidence = 'high'; // repeated = confirmed
        } else {
          updated.knowledge = [entry, ...(updated.knowledge || [])].slice(0, 50);
        }
      } else {
        // Working memory — recent context, expires faster
        updated.working = [entry, ...(updated.working || [])].slice(0, 20);
      }
    }

    await saveMemory(userId, updated);
    return { suggestQuestion: result.suggestQuestion || null };

  } catch (err) {
    console.error('[memory extraction error]', err.message);
    return { suggestQuestion: null };
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    message,
    history = [],
    userId = 'anonymous',
    workflowConfirmed,
    workflowDeclined,
  } = req.body;

  if (!message?.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    // ── Load memory ────────────────────────────────────────────────────────
    const memoryState = await loadMemory(userId);
    const memoryContext = buildMemoryContext(memoryState);

    // ── Detect workflow ────────────────────────────────────────────────────
    let activeWorkflow = WORKFLOWS.general;

    if (workflowConfirmed) {
      activeWorkflow = WORKFLOWS[workflowConfirmed] ?? WORKFLOWS.general;
    } else if (!workflowDeclined && history.length === 0) {
      const { workflow, confidence } = detectWorkflow(message);
      if (workflow.id !== 'general' && confidence === 'high') {
        activeWorkflow = workflow;
      }
    }

    // ── Sanitize history (must strictly alternate roles) ──────────────────
    const sanitized = [];
    for (const m of history) {
      const last = sanitized[sanitized.length - 1];
      if (!last || last.role !== m.role) sanitized.push(m);
    }

    // ── Build messages ─────────────────────────────────────────────────────
    const systemPrompt = buildSystemPrompt(activeWorkflow, memoryContext);
    const messages = [
      ...sanitized.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];

    // ── Call Claude ────────────────────────────────────────────────────────
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: systemPrompt,
      messages,
    });

    const assistantMessage = response.content[0]?.text ?? '';

    // ── Memory extraction (async, non-blocking) ────────────────────────────
    // Runs after response is sent — user never waits for this
    const extractionPromise = extractAndStoreMemory(
      userId,
      message,
      assistantMessage,
      sanitized,
      memoryState
    );

    // ── Send response immediately ──────────────────────────────────────────
    const { suggestQuestion } = await extractionPromise;

    return res.status(200).json({
      type: 'message',
      message: assistantMessage,
      workflow: activeWorkflow,
      // If extraction found an ambiguous topic worth clarifying,
      // pass it back so the frontend can optionally surface it
      memoryPrompt: suggestQuestion || null,
    });

  } catch (error) {
    console.error('[chat] error:', error.message);
    return res.status(500).json({
      error: 'Something went wrong. Please try again.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
}
