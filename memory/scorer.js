// memory/scorer.js
// Memory Value Scoring

import { SCORE_THRESHOLDS } from './types.js';

const MS_PER_DAY = 86_400_000;

export function scoreEntry(memory) {
  let score = 0;

  if (memory.anchor) score += 1000;
  if (memory.weight === 'major') score += 100;

  if (memory.confidence === 'high') score += 20;
  else if (memory.confidence === 'medium') score += 10;

  if (memory.source === 'stated') score += 5;
  if (memory.source === 'synthesized') score += 15;

  const ageDays = (Date.now() - new Date(memory.updated_at).getTime()) / MS_PER_DAY;
  if (ageDays < 1) score += 25;
  else if (ageDays < 7) score += 15;
  else if (ageDays > 90) score -= 20;
  else if (ageDays > 30) score -= 10;

  score += Math.min((memory.occurrences || 1) * 3, 15);

  return Math.max(0, score);
}

// Maps a memory + its score onto the Constitution's four memory tiers:
// active (in active use right now), working (everyday useful context),
// knowledge (durable, synthesized understanding), archive (low-value, kept but deprioritized).
export function decideTier(score, memory) {
  if (memory && memory.anchor) return 'active';
  if (score >= SCORE_THRESHOLDS.active) return 'active';
  if (memory && memory.source === 'synthesized') return 'knowledge';
  if (score >= SCORE_THRESHOLDS.promote) return 'knowledge';
  if (score >= SCORE_THRESHOLDS.compress) return 'working';
  return 'archive';
}

export function enforceBudget(memories, budgets) {
  // Active-tier memories (anchors, currently-relevant) are never budget-constrained.
  const result = [];
  const tiers = { working: [], archive: [], knowledge: [] };

  for (const m of memories) {
    const s = scoreEntry(m);
    const tier = decideTier(s, m);
    if (tier === 'active') {
      result.push({ ...m, _score: s });
    } else {
      tiers[tier].push({ ...m, _score: s });
    }
  }

  for (const [tier, items] of Object.entries(tiers)) {
    const budget = budgets[tier] || 0;
    let size = 0;
    for (const item of items.sort((a, b) => b._score - a._score)) {
      const bytes = Buffer.byteLength(item.content, 'utf8');
      if (size + bytes > budget) break;
      result.push(item);
      size += bytes;
    }
  }

  return result;
}
