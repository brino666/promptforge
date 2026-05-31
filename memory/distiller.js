// memory/distiller.js
// PromptForge Memory System — Meaning Extraction
// Runs once at session end. Extracts what was LEARNED, not what was SAID.
// Uses claude-haiku — cheapest model, ~$0.001 per session.

const EXTRACTION_SYSTEM_PROMPT = `You are a memory distillation system.
Extract durable knowledge from a conversation summary.

Rules:
- Extract only stable, reusable information
- Ignore one-off questions and transient context
- Focus on preferences, goals, patterns, and project state
- Never store raw conversation text
- Be conservative — less is better than noise
- Ask: "Will this still help the user in 30 days?" If no, exclude it.

Respond ONLY with valid JSON. No preamble, no markdown fences.
Schema:
{
  "preferences": [{ "pattern": "string", "value": "string", "confidence": 0.0-1.0 }],
  "goals": [{ "description": "string", "status": "active|completed|abandoned", "confidence": 0.0-1.0 }],
  "patterns": [{ "observation": "string", "confidence": 0.0-1.0 }],
  "projectContext": [{ "project": "string", "state": "string", "confidence": 0.0-1.0 }]
}`;

export class Distiller {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  async extract(active) {
    if (active.turnCount < 3 || active.conversationSummary.length === 0) {
      return null;
    }

    const summaryText = active.conversationSummary.join('\n');
    const userPrompt = `Conversation summary:
${summaryText}

Current project: ${active.currentProject ?? 'unknown'}
Current task: ${active.currentTask ?? 'unknown'}
Session turns: ${active.turnCount}

Extract durable knowledge. Only include what will still be useful in 30 days.`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1000,
          system: EXTRACTION_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });

      const data = await response.json();
      const text = data.content?.[0]?.text;
      if (!text) return null;

      const clean = text.replace(/```json|```/g, '').trim();
      const extracted = JSON.parse(clean);

      return {
        preferences:    (extracted.preferences    ?? []).filter((p) => p.confidence >= 0.6),
        goals:          (extracted.goals          ?? []).filter((g) => g.confidence >= 0.6),
        patterns:       (extracted.patterns       ?? []).filter((p) => p.confidence >= 0.7),
        projectContext: (extracted.projectContext ?? []).filter((p) => p.confidence >= 0.6),
      };
    } catch (err) {
      console.error('[distiller] extraction failed:', err.message);
      return null;
    }
  }
}
