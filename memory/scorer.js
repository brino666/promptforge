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

export function decideTier(score) {
  if (score >= SCORE_THRESHOLDS.promote) return 'knowledge';
  if (score >= SCORE_THRESHOLDS.compress) return 'working';
  if (score >= SCORE_THRESHOLDS.delete) return 'archive';
  return 'delete';
}

export function enforceBudget(memories, budgets) {
  const tiers = { working: [], archive: [], knowledge: [] };

  for (const m of memories) {
    const s = scoreEntry(m);
    const tier = decideTier(s);
    if (tier !== 'delete' && tiers[tier]) {
      tiers[tier].push({ ...m, _score: s });
    }
  }

  const result = [];
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