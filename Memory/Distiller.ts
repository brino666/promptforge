// memory/distiller.ts
// PromptForge Memory System v2 — Meaning Extraction
//
// This is the Claude-powered half of Option C.
// Runs once at session end.
// Extracts what was LEARNED, not what was SAID.
// Cost: ~$0.001 per session (small Claude call).

import type { ExtractedKnowledge, ActiveMemory } from './types.js';

// ── Extraction prompt ─────────────────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You are a memory distillation system.
Your job is to extract durable knowledge from a conversation summary.

Rules:
- Extract only stable, reusable information
- Ignore one-off questions and transient context
- Focus on preferences, goals, patterns, and project state
- Never store raw conversation text
- Be conservative — it's better to extract less than to store noise
- Confidence should reflect how certain you are this is a stable pattern

Ask yourself before including anything:
"Will this still help the user in 30 days?"
If no — exclude it.

Respond ONLY with valid JSON matching the ExtractedKnowledge schema.
No preamble, no explanation, no markdown fences.`;

const EXTRACTION_SCHEMA = `{
  "preferences": [
    { "pattern": "string", "value": "string", "confidence": 0.0-1.0 }
  ],
  "goals": [
    { "description": "string", "status": "active|completed|abandoned", "confidence": 0.0-1.0 }
  ],
  "patterns": [
    { "observation": "string", "confidence": 0.0-1.0 }
  ],
  "projectContext": [
    { "project": "string", "state": "string", "confidence": 0.0-1.0 }
  ]
}`;

// ── Distiller ─────────────────────────────────────────────────────────────────

export class Distiller {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Extract knowledge from the active session.
   * Called once at session end.
   *
   * @param active - The Tier 1 active memory (conversation summary)
   * @returns Structured knowledge ready for Tier 2/3/4 storage
   */
  async extract(active: ActiveMemory): Promise<ExtractedKnowledge | null> {
    // Not enough context to extract anything useful
    if (active.turnCount < 3 || active.conversationSummary.length === 0) {
      return null;
    }

    const summaryText = active.conversationSummary.join('\n');

    const userPrompt = `Here is a summary of a conversation session:

${summaryText}

Current project: ${active.currentProject ?? 'unknown'}
Current task: ${active.currentTask ?? 'unknown'}
Session turns: ${active.turnCount}

Extract durable knowledge following this schema:
${EXTRACTION_SCHEMA}

Remember: only extract what will still be useful in 30 days.`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001', // cheapest model, sufficient for extraction
          max_tokens: 1000,
          system: EXTRACTION_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });

      const data = await response.json();
      const text = data.content?.[0]?.text;
      if (!text) return null;

      // Strip any accidental markdown fences
      const clean = text.replace(/```json|```/g, '').trim();
      const extracted = JSON.parse(clean) as ExtractedKnowledge;

      // Filter out low-confidence extractions
      return {
        preferences:    extracted.preferences?.filter((p) => p.confidence >= 0.6) ?? [],
        goals:          extracted.goals?.filter((g) => g.confidence >= 0.6) ?? [],
        patterns:       extracted.patterns?.filter((p) => p.confidence >= 0.7) ?? [],
        projectContext: extracted.projectContext?.filter((p) => p.confidence >= 0.6) ?? [],
      };
    } catch (err) {
      // Distillation failure is non-fatal — session continues without extraction
      console.error('[distiller] Extraction failed:', err);
      return null;
    }
  }

  /**
   * Summarize a long conversation into a single compressed entry.
   * Used when the conversation summary grows too long.
   */
  async summarize(lines: string[]): Promise<string> {
    if (lines.length <= 3) return lines.join(' ');

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
          max_tokens: 200,
          system: 'Compress the following conversation notes into one or two sentences. Preserve only the most important context. Be concise.',
          messages: [{
            role: 'user',
            content: lines.join('\n'),
          }],
        }),
      });

      const data = await response.json();
      return data.content?.[0]?.text ?? lines[lines.length - 1];
    } catch {
      // Fall back to last entry
      return lines[lines.length - 1];
    }
  }
}
