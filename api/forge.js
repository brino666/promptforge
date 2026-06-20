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

  // Anonymous access is closed, matching chat.js policy.
  // NOTE: sessionContext.userId is frontend-supplied and not independently
  // verified here the way chat.js's auth flow works -- this blocks the
  // default/no-context case (truly anonymous) but is not a substitute for
  // real server-side auth if this endpoint needs hardening further later.
  const userId = sessionContext && sessionContext.userId;
  if (!userId || userId === 'anonymous') {
    return res.status(200).json({
      content: [{
        type: 'text',
        text: JSON.stringify({
          position: '', context: '', objective: '', manner: '', audience: '', format: '', forge: '',
          assembled: 'Please sign in or create a free account to use Forge.',
        }),
      }],
      requiresAuth: true,
    });
  }

  try {
    let memoryOffer = null;

    if (sessionContext) {
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
