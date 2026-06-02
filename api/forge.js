// api/forge.js
// Thais — Core transformation endpoint with memory integration

import Anthropic from '@anthropic-ai/sdk';
import { Distiller } from '../memory/distiller.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

let distiller = null;

function getDistiller() {
  if (!distiller) {
    distiller = new Distiller(process.env.ANTHROPIC_API_KEY);
  }
  return distiller;
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
    const distillerInstance = getDistiller();

    // === MEMORY INTEGRATION ===
    let memoryContext = '';
    let memoryOffer = null;

    // If we receive session context, we can prepare memory features
    if (sessionContext) {
      // In a full implementation we would:
      // - Load or create a MemoryStore for the user
      // - Run distillation when appropriate
      // - Build memory context to inject into prompts
      // - Decide whether to offer memory features to the user

      memoryOffer = {
        available: true,
        type: 'session_memory',
        message: 'Memory features are ready. Session context received.',
      };

      // Placeholder for future memory context injection
      if (sessionContext.conversationSummary?.length > 0) {
        memoryContext = 'Previous context available in this session.';
      }
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