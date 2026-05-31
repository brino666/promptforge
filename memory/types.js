// memory/types.js
// PromptForge Memory System v2
// "Remember what was learned, not what was said."

// Tier budgets in bytes
export const TIER_BUDGETS = {
  working:   50_000,   // 50KB
  archive:   200_000,  // 200KB
  knowledge: 50_000,   // 50KB
};

export const TOTAL_BUDGET = 300_000; // 300KB per user

// Score thresholds
export const SCORE_THRESHOLDS = {
  compress: 0.3,  // below this → move to archive
  delete:   0.1,  // below this → remove entirely
  promote:  0.8,  // above this → promote to knowledge tier
};
