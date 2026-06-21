// api/forge.js
// Thais — Core transformation endpoint
// FIX: Removed broken Distiller import (memory/distiller.js does not exist yet)
// FIX: Updated model to claude-sonnet-4-6 for consistency

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt, sessionContext } = req.body;

  if (!prompt?.trim()) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  // Anonymous users get exactly ONE free forge conversion as a preview.
  // Forge is single-shot (no conversation history concept like chat.js has),
  // so "one exchange" here means: let exactly one request through per fresh
  // session, then the frontend is responsible for not offering Forge again
  // in that browser session. sessionContext.usedFreeForge is a flag the
  // frontend sets after a successful anonymous conversion.
  const userId = sessionContext && sessionContext.userId;
  const isLoggedIn = !!userId && userId !== 'anonymous';
  const alreadyUsedTrial = sessionContext && sessionContext.usedFreeForge;

  if (!isLoggedIn && alreadyUsedTrial) {
    return res.status(200).json({
      content: [{
        type: 'text',
        text: JSON.stringify({
          position: '', context: '', objective: '', manner: '', audience: '', format: '', forge: '',
          assembled: 'That was your free preview. Sign in or create a free account to keep using Forge.',
        }),
      }],
      requiresAuth: true,
    });
  }

  try {
    let memoryOffer = null;

    if (sessionContext && isLoggedIn) {
      memoryOffer = {
        available: true,
        type: 'session_memory',
        message: 'Memory features are ready. Session context received.',
      };
    }

    const systemPrompt = `You are an expert prompt engineer. Restructure the user's prompt using the PROMPT framework.
Respond ONLY with a valid JSON object with keys: position, context, objective, manner, audience, format, forge, assembled.
No preamble, no explanation, no markdown.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    });

    return res.status(200).json({
      content: response.content,
      memoryOffer,
      memoryContext: null,
    });

  } catch (error) {
    console.error('[forge] error:', error.message);
    return res.status(500).json({
      error: 'Failed to process prompt',
      details: error.message,
    });
  }
}
