// api/forge.js
// PromptForge v2 — API with full four-tier memory pipeline
//
// Flow per request:
//   1. Load memory state from Redis
//   2. Handle pending offer response if any
//   3. Build memory-enhanced system prompt
//   4. Process user message (rule-based detection)
//   5. Call Claude
//   6. Track assistant response in active memory
//   7. End session → Claude extracts → compress → save to Redis
//   8. Return response + memory offer if triggered

import Anthropic from '@anthropic-ai/sdk';
import { MemoryManager } from '../memory/index.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ── Upstash Redis ─────────────────────────────────────────────────────────────

async function redisGet(key) {
  const res = await fetch(
    `${process.env.KV_REST_API_URL}/get/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` } }
  );
  const data = await res.json();
  return data.result ? JSON.parse(data.result) : null;
}

async function redisSet(key, value) {
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
}

async function loadMemoryState(userId) {
  try { return await redisGet(`memory:${userId}`); }
  catch (err) { console.error('[memory] load failed:', err.message); return null; }
}

async function saveMemoryState(userId, state) {
  try { await redisSet(`memory:${userId}`, state); }
  catch (err) { console.error('[memory] save failed:', err.message); }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    prompt,
    userId        = 'anonymous',
    memoryAction,   // 'accept' | 'decline'
    pendingPhrase,  // from a previous offer
    userPassword,   // TODO: derive from auth token in production
  } = req.body;

  if (!prompt?.trim()) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  try {
    // 1. Load + initialize memory
    const savedState = await loadMemoryState(userId);
    const password = userPassword
      || process.env.DEFAULT_MEMORY_KEY
      || 'changeme';

    const memory = await MemoryManager.create(
      password,
      process.env.ANTHROPIC_API_KEY,
      savedState
    );

    // 2. Handle pending offer response
    if (memoryAction && pendingPhrase) {
      await memory.handleOfferResponse(memoryAction === 'accept');
    }

    // 3. Build memory-enhanced system prompt
    const memoryContext = await memory.getSystemPromptAddition();
    const systemPrompt = [
      `You are an expert prompt engineer.
Restructure the user's prompt using the PROMPT framework.
Respond ONLY with a valid JSON object with keys:
position, context, objective, manner, audience, format, forge, assembled.
No preamble, no explanation, no markdown.`,
      memoryContext,
    ].filter(Boolean).join('\n\n');

    // 4. Rule-based detection on user message
    const memoryOffer = memory.processMessage(prompt, 'user');

    // 5. Call Claude
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    });

    // 6. Track assistant response
    const assistantText = response.content?.[0]?.text ?? '';
    memory.processMessage(assistantText, 'assistant');

    // 7. End session — Claude extracts meaning, compress, save
    const sessionStats = await memory.endSession();
    await saveMemoryState(userId, memory.export(userId));

    console.log(`[memory] session stats:`, sessionStats);

    // 8. Return
    return res.status(200).json({
      content: response.content,
      memoryOffer: memoryOffer ?? null,
    });

  } catch (error) {
    console.error('[forge] error:', error.message);
    return res.status(500).json({
      error: 'Failed to process prompt',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
}
