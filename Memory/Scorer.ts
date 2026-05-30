// memory/scorer.ts
// PromptForge Memory System v2 — Value Scoring
//
// Every memory entry gets a score.
// Score determines whether it lives, compresses, archives, or dies.
// "The system should remember what was learned, not what was said."

import type { MemoryEntry, MemoryScore } from './types.js';
import { SCORE_THRESHOLDS } from './types.js';

const MS_PER_DAY = 86_400_000;

// ── Score calculation ─────────────────────────────────────────────────────────

/**
 * Calculate a composite score for a memory entry.
 * Weights: confirmed > importance > frequency > recency
 */
export function scoreEntry(entry: MemoryEntry, now = Date.now()): MemoryScore {
  // Recency: full score if used today, decays to 0 over 90 days
  const daysSinceUse = (now - entry.lastUsed) / MS_PER_DAY;
  const recency = Math.max(0, 1 - daysSinceUse / 90);

  // Frequency: logarithmic scale, caps at 20 uses
  const frequency = Math.min(1, Math.log10(entry.useCount + 1) / Math.log10(21));

  // Importance: preserved from creation (set by extractor)
  const importance = entry.score.importance;

  // Confirmed: binary — user said yes = big boost
  const confirmed = entry.userVerified ? 1 : 0;

  // Weighted composite
  const total =
    confirmed  * 0.40 +
    importance * 0.30 +
    frequency  * 0.20 +
    recency    * 0.10;

  return { recency, frequency, importance, confirmed, total };
}

/**
 * Update a memory entry's score in place.
 */
export function refreshScore(entry: MemoryEntry, now = Date.now()): MemoryEntry {
  return { ...entry, score: scoreEntry(entry, now) };
}

// ── Tier decisions ────────────────────────────────────────────────────────────

export type TierDecision =
  | 'keep'      // score is healthy, stay in current tier
  | 'promote'   // score is high → move up to knowledge tier
  | 'compress'  // score is low → move down to archive
  | 'delete'    // score is very low → remove

/**
 * Decide what to do with a memory entry based on its score.
 */
export function decideTier(entry: MemoryEntry): TierDecision {
  const score = entry.score.total;

  // User-verified entries are never deleted, only compressed at worst
  if (entry.userVerified) {
    if (score >= SCORE_THRESHOLDS.promote) return 'promote';
    return 'keep';
  }

  if (score >= SCORE_THRESHOLDS.promote) return 'promote';
  if (score < SCORE_THRESHOLDS.delete)   return 'delete';
  if (score < SCORE_THRESHOLDS.compress) return 'compress';
  return 'keep';
}

// ── Budget enforcement ────────────────────────────────────────────────────────

/**
 * Given a list of entries and a byte budget,
 * returns entries sorted by score, trimmed to fit the budget.
 *
 * Lowest-scored entries are removed first.
 * User-verified entries are always preserved.
 */
export function enforcebudget(
  entries: MemoryEntry[],
  budgetBytes: number
): MemoryEntry[] {
  // Always keep user-verified entries
  const verified = entries.filter((e) => e.userVerified);
  const unverified = entries.filter((e) => !e.userVerified);

  // Sort unverified by score descending
  unverified.sort((a, b) => b.score.total - a.score.total);

  const result: MemoryEntry[] = [...verified];
  let usedBytes = estimateBytes(verified);

  for (const entry of unverified) {
    const entrySize = estimateBytes([entry]);
    if (usedBytes + entrySize <= budgetBytes) {
      result.push(entry);
      usedBytes += entrySize;
    }
    // If it doesn't fit, it's dropped — budget wins
  }

  return result;
}

/**
 * Rough byte estimate for a list of entries.
 * Used for budget enforcement — doesn't need to be exact.
 */
export function estimateBytes(entries: MemoryEntry[]): number {
  return entries.reduce((sum, e) => {
    return sum + JSON.stringify(e).length;
  }, 0);
}

// ── Recency decay ─────────────────────────────────────────────────────────────

/**
 * Apply recency decay to all entries.
 * Entries that haven't been used recently lose score over time.
 * Run this during compression (session end).
 */
export function applyDecay(entries: MemoryEntry[], now = Date.now()): MemoryEntry[] {
  return entries.map((e) => refreshScore(e, now));
}
