// memory/scorer.js
// PromptForge Memory System — Value Scoring

import { SCORE_THRESHOLDS } from './types.js';

const MS_PER_DAY = 86_400_000;

export function scoreEntry(entry, now = Date.now()) {
  const daysSinceUse = (now - entry.lastUsed) / MS_PER_DAY;
  const recency    = Math.max(0, 1 - daysSinceUse / 90);
  const frequency  = Math.min(1, Math.log10(entry.useCount + 1) / Math.log10(21));
  const importance = entry.score.importance;
  const confirmed  = entry.userVerified ? 1 : 0;

  const total =
    confirmed  * 0.40 +
    importance * 0.30 +
    frequency  * 0.20 +
    recency    * 0.10;

  return { recency, frequency, importance, confirmed, total };
}

export function refreshScore(entry, now = Date.now()) {
  return { ...entry, score: scoreEntry(entry, now) };
}

export function decideTier(entry) {
  const score = entry.score.total;
  if (entry.userVerified) {
    return score >= SCORE_THRESHOLDS.promote ? 'promote' : 'keep';
  }
  if (score >= SCORE_THRESHOLDS.promote) return 'promote';
  if (score < SCORE_THRESHOLDS.delete)   return 'delete';
  if (score < SCORE_THRESHOLDS.compress) return 'compress';
  return 'keep';
}

export function enforceBudget(entries, budgetBytes) {
  const verified   = entries.filter((e) => e.userVerified);
  const unverified = entries.filter((e) => !e.userVerified)
    .sort((a, b) => b.score.total - a.score.total);

  const result = [...verified];
  let usedBytes = estimateBytes(verified);

  for (const entry of unverified) {
    const size = estimateBytes([entry]);
    if (usedBytes + size <= budgetBytes) {
      result.push(entry);
      usedBytes += size;
    }
  }
  return result;
}

export function estimateBytes(entries) {
  return entries.reduce((sum, e) => sum + JSON.stringify(e).length, 0);
}
