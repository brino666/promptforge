// api/forge.js — simplified, memory bypassed temporarily
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt } = req.body;
  if (!prompt?.trim()) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      system: `You are an expert prompt engineer. Restructure the user's prompt using the PROMPT framework. Respond ONLY with a valid JSON object with keys: position, context, objective, manner, audience, format, forge, assembled. No preamble, no explanation, no markdown.`,
      messages: [{ role: 'user', content: prompt }],
    });

    return res.status(200).json({
      content: response.content,
      memoryOffer: null,
    });

  } catch (error) {
    console.error('[forge] error:', error.message);
    return res.status(500).json({
      error: 'Failed to process prompt',
      details: error.message,
    });
  }
}
