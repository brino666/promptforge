// memory/types.js
// Memory System v2
// "Remember what was learned, not what was said."

// Tier budgets in bytes
export const TIER_BUDGETS = {
  working:   50_000,   // 50KB
  archive:   200_000,  // 200KB
  knowledge: 50_000,   // 50KB
};

export const TOTAL_BUDGET = 300_000; // 300KB per user

// Score thresholds — on the same scale as scoreEntry() in scorer.js
// (anchors alone score 1000+, so these are tuned against that range, not 0-1).
export const SCORE_THRESHOLDS = {
  active:   150, // recent, major, high-confidence, or anchored → active tier
  promote:  80,  // synthesized/strong recurring knowledge → knowledge tier
  compress: 30,  // everyday useful context → working tier
  delete:   10,  // below this → archive tier (kept but deprioritized)
};