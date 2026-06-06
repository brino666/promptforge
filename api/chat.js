// api/chat.js
// Thais — Conversation Mode API
// Handles multi-turn chat with workflow identification,
// collaborative confirmation, and memory integration.

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ── Workflow definitions ──────────────────────────────────────────────────────

const WORKFLOWS = {
  content: {
    id: 'content',
    label: 'Content workflow',
    icon: '✍',
    description: 'Writing, editing, copy, storytelling',
    keywords: ['write', 'draft', 'copy', 'blog', 'post', 'email', 'landing', 'content', 'article', 'essay', 'story'],
  },
  code: {
    id: 'code',
    label: 'Development workflow',
    icon: '⌨',
    description: 'Code, debugging, architecture, review',
    keywords: ['code', 'build', 'debug', 'function', 'api', 'app', 'script', 'error', 'implement', 'deploy', 'fix'],
  },
  research: {
    id: 'research',
    label: 'Research workflow',
    icon: '🔍',
    description: 'Investigation, analysis, comparison',
    keywords: ['research', 'find', 'compare', 'analyze', 'investigate', 'understand', 'explain', 'what is', 'how does', 'why'],
  },
  decision: {
    id: 'decision',
    label: 'Decision workflow',
    icon: '⚖',
    description: 'Options, evaluation, choice',
    keywords: ['decide', 'choose', 'should i', 'better', 'which', 'option', 'tradeoff', 'pros', 'cons', 'recommend'],
  },
  planning: {
    id: 'planning',
    label: 'Planning workflow',
    icon: '📋',
    description: 'Strategy, roadmap, next steps',
    keywords: ['plan', 'strategy', 'roadmap', 'next', 'steps', 'how to', 'approach', 'organize', 'structure', 'outline'],
  },
  general: {
    id: 'general',
    label: 'General conversation',
    icon: '💬',
    description: 'Open-ended discussion',
    keywords: [],
  },
};

// ── Workflow detection ────────────────────────────────────────────────────────

function detectWorkflow(message) {
  const lower = message.toLowerCase();
  let bestMatch = 'general';
  let bestScore = 0;

  for (const [id, workflow] of Object.entries(WORKFLOWS)) {
    if (id === 'general') continue;
    const score = workflow.keywords.filter((kw) => lower.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = id;
    }
  }

  return {
    workflow: WORKFLOWS[bestMatch],
    confidence: bestScore > 1 ? 'high' : bestScore === 1 ? 'medium' : 'low',
  };
}

// ── Upstash Redis ─────────────────────────────────────────────────────────────

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

async function redisSet(key, value) {
  try {
    await fetch(
      `${process.env.KV_REST_API_URL}/set/${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ value: JSON.stringify(value) }),
      }
    );
  } catch { /* non-fatal */ }
}

// ── System prompt builder ─────────────────────────────────────────────────────

function buildSystemPrompt(workflow, memoryContext) {
  const workflowGuide = {
    content:  'You are helping with a content or writing task. Be creative, clear, and direct. Offer concrete drafts rather than advice about writing.',
    code:     'You are helping with a development task. Be precise, show working code, explain your reasoning. Catch potential issues proactively.',
    research: 'You are helping with research or analysis. Be thorough, cite reasoning, surface non-obvious insights. Distinguish fact from inference.',
    decision: 'You are helping with a decision. Present options clearly, highlight tradeoffs, give a recommendation with reasoning.',
    planning: 'You are helping with planning or strategy. Be structured, think in steps, surface dependencies and risks.',
    general:  'You are Thais, a calm and thoughtful AI workspace. Be direct, warm, and genuinely helpful.',
  };

  const base = `You are Thais — a private, calm, memory-aware AI workspace.
Your personality: direct, warm, unhurried. Never performatively enthusiastic.
Never say "Great question!" or "Certainly!" Just respond.

${workflowGuide[workflow?.id ?? 'general']}

Core principles:
- Preserve user momentum. Get to the point.
- Be honest about uncertainty.
- Never store or reference information the user hasn't shared in this session.
- If memory context is provided, use it naturally without announcing it.`;

  if (memoryContext && memoryContext.trim()) {
    return `${base}\n\n${memoryContext}`;
  }

  return base;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    message,
    history = [],           // array of {role, content} pairs
    userId = 'anonymous',
    workflowConfirmed,      // null | workflow id (user confirmed this workflow)
    workflowDeclined,       // true if user said "no" to workflow suggestion
  } = req.body;

  if (!message?.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    // ── Load memory context ────────────────────────────────────────────────
    const memoryState = await redisGet(`memory:${userId}`);
    let memoryContext = '';

    if (memoryState?.knowledge?.length > 0 || memoryState?.working?.length > 0) {
      const lines = [];
      if (memoryState.knowledge?.length > 0) {
        lines.push('What I know about you:');
        memoryState.knowledge.slice(0, 5).forEach((e) => {
          if (e.encryptedValue) lines.push(`- ${e.pattern}`);
        });
      }
      if (memoryState.working?.length > 0) {
        lines.push('Recent context:');
        memoryState.working.slice(0, 3).forEach((e) => {
          if (e.encryptedValue) lines.push(`- ${e.pattern}`);
        });
      }
      if (lines.length > 0) {
        memoryContext = `---\n${lines.join('\n')}\n---`;
      }
    }

    // ── Detect workflow ────────────────────────────────────────────────────
    const isFirstMessage = history.length === 0;
    let activeWorkflow = null;
    let needsConfirmation = false;

    if (false) {
      const { workflow, confidence } = detectWorkflow(message);

      if (workflow.id !== 'general' && confidence !== 'low') {
        // Suggest this workflow collaboratively
        return res.status(200).json({
          type: 'workflow_suggestion',
          workflow,
          confidence,
          message: `Looks like a ${workflow.label.toLowerCase()}. Starting there — sound right?`,
        });
      }
      activeWorkflow = WORKFLOWS.general;
    } else if (workflowConfirmed) {
      activeWorkflow = WORKFLOWS[workflowConfirmed] ?? WORKFLOWS.general;
    } else {
      // Either declined or continuing conversation
      activeWorkflow = WORKFLOWS.general;
    }

    // ── Build messages ─────────────────────────────────────────────────────
    const systemPrompt = buildSystemPrompt(activeWorkflow, memoryContext);

    // Sanitize history — must strictly alternate roles
const sanitized = [];
for (const m of history) {
  const last = sanitized[sanitized.length - 1];
  if (!last || last.role !== m.role) sanitized.push(m);
}
const messages = [
  ...sanitized.map((m) => ({ role: m.role, content: m.content })),
  { role: 'user', content: message },
];

    // ── Call Claude ────────────────────────────────────────────────────────
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-2025',
      max_tokens: 2000,
      system: systemPrompt,
      messages,
    });

    const assistantMessage = response.content[0]?.text ?? '';

    // ── Update session memory (lightweight) ───────────────────────────────
    // Store conversation summary for memory extraction later
    const sessionKey = `session:${userId}:${Date.now()}`;
    await redisSet(sessionKey, {
      workflow: activeWorkflow?.id,
      userMessage: message.slice(0, 200),
      timestamp: Date.now(),
    });

    return res.status(200).json({
      type: 'message',
      message: assistantMessage,
      workflow: activeWorkflow,
    });

  } catch (error) {
    console.error('[chat] error:', error.message);
    return res.status(500).json({
      error: 'Something went wrong. Please try again.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
}
