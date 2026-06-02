// api/forge.js
// Theius — Core prompt transformation endpoint with memory integration hooks

import Anthropic from '@anthropic-ai/sdk';
import { Distiller } from '../memory/distiller.js';
import { MemoryStore } from '../memory/store.js';

// TODO: In production, load user-specific encryption key and persistent state
// For now, memory is prepared but not fully persisted across requests
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Placeholder for future user memory initialization
// In a real session flow you would load or create a MemoryStore per user
let memoryStore = null;
let distiller = null;

function ensureMemoryInitialized(apiKey) {
  if (!distiller) {
    distiller = new Distiller(apiKey);
  }
  // memoryStore would normally be loaded from encrypted user state
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt, sessionContext } = req.body;
  if (!prompt?.trim()) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  try {
    ensureMemoryInitialized(process.env.ANTHROPIC_API_KEY);

    // === MEMORY INTEGRATION POINT ===
    // When sessionContext is provided (future), we can:
    // 1. Load or initialize MemoryStore for the user
    // 2. Run distiller.extract() at end of meaningful sessions
    // 3. Inject relevant memory into the system prompt via buildSystemPromptAddition()
    // 4. Return memoryOffer suggestions to the frontend

    let memoryContext = '';
    let memoryOffer = null;

    if (sessionContext && distiller) {
      // Example future usage:
      // const extracted = await distiller.extract(sessionContext);
      // if (extracted) {
      //   await memoryStore.ingestExtracted(extracted);
      //   memoryContext = await memoryStore.buildSystemPromptAddition();
      // }
      memoryOffer = { status: 'ready', message: 'Memory system is wired and ready for session context.' };
    }

    const systemPrompt = `You are an expert prompt engineer. Restructure the user's prompt using the PROMPT framework.
Respond ONLY with a valid JSON object with keys: position, context, objective, manner, audience, format, forge, assembled.
No preamble, no explanation, no markdown.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    });

    return res.status(200).json({
      content: response.content,
      memoryOffer,
      memoryContext: memoryContext || null,
    });

  } catch (error) {
    console.error('[forge] error:', error.message);
    return res.status(500).json({
      error: 'Failed to process prompt',
      details: error.message,
    });
  }
}