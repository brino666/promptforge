// memory/types.ts
// PromptForge Memory System v2
// "Remember what was learned, not what was said."
//
// Four-tier architecture:
//   Tier 1 — Active    (RAM only, never stored)
//   Tier 2 — Working   (Redis, fast, ~50KB budget)
//   Tier 3 — Archive   (Redis, compressed, ~200KB budget)
//   Tier 4 — Knowledge (Redis, permanent, ~50KB budget)

// ── Tiers ─────────────────────────────────────────────────────────────────────

export type MemoryTier =
  | 'active'     // Tier 1: current session, RAM only
  | 'working'    // Tier 2: recent preferences + active goals
  | 'archive'    // Tier 3: compressed history
  | 'knowledge'  // Tier 4: distilled facts + stable patterns

// ── Value scoring ─────────────────────────────────────────────────────────────

export interface MemoryScore {
  recency:    number  // 0-1, decays over time
  frequency:  number  // 0-1, how often this entry was used
  importance: number  // 0-1, inferred signal strength
  confirmed:  number  // 0 or 1, user explicitly verified

  // Composite — weighted average
  // < 0.3 → candidate for compression
  // < 0.1 → candidate for deletion
  total: number
}

// ── Memory entry ──────────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string
  tier: MemoryTier

  // What was learned — never raw conversation text
  pattern: string       // human-readable label
  value: string         // the actual learned content
  utility: string       // what this helps with

  // Scoring
  score: MemoryScore
  createdAt: number
  lastUsed: number
  useCount: number

  // User control
  userVerified: boolean
  userDeclined: boolean
  deletable: boolean    // always true

  // Compression tracking
  mergedFrom: string[]  // ids this replaced
  sourceTier: MemoryTier | null  // which tier this was promoted from

  // Encryption
  encryptedValue: string  // value encrypted at rest
}

// ── Tier budgets ──────────────────────────────────────────────────────────────

export const TIER_BUDGETS: Record<Exclude<MemoryTier, 'active'>, number> = {
  working:   50_000,   // 50KB
  archive:   200_000,  // 200KB
  knowledge: 50_000,   // 50KB
}

export const TOTAL_BUDGET = 300_000  // 300KB per user

// ── Score thresholds ──────────────────────────────────────────────────────────

export const SCORE_THRESHOLDS = {
  compress: 0.3,  // below this → move to archive
  delete:   0.1,  // below this → remove entirely
  promote:  0.8,  // above this → promote to knowledge tier
}

// ── Distillation pipeline ─────────────────────────────────────────────────────

// What Claude extracts from a conversation at session end
export interface ExtractedKnowledge {
  preferences: Array<{
    pattern: string
    value: string
    confidence: number  // 0-1
  }>
  goals: Array<{
    description: string
    status: 'active' | 'completed' | 'abandoned'
    confidence: number
  }>
  patterns: Array<{
    observation: string
    confidence: number
  }>
  projectContext: Array<{
    project: string
    state: string
    confidence: number
  }>
}

// ── Session state (Tier 1, RAM only) ─────────────────────────────────────────

export interface ActiveMemory {
  conversationSummary: string[]  // rolling summary, max 10 entries
  currentTask: string | null
  currentProject: string | null
  turnCount: number
  startedAt: number
}

// ── Persisted state (what goes in Redis) ─────────────────────────────────────

export interface PersistedMemoryState {
  userId: string
  saltB64: string
  working:   MemoryEntry[]
  archive:   MemoryEntry[]
  knowledge: MemoryEntry[]
  repetitions: [string, RepetitionRecord][]
  lastCompressed: number
  version: number
}

// ── Repetition detection ──────────────────────────────────────────────────────

export interface RepetitionRecord {
  normalized: string
  count: number
  firstSeen: number
  lastSeen: number
  offered: boolean
  declined: boolean
}

// ── Memory offer ──────────────────────────────────────────────────────────────

export interface MemoryOffer {
  shouldOffer: boolean
  phrase: string
  message: 'I can remember that if you like.'
}

// ── Context injected into Claude at session start ─────────────────────────────

export interface MemoryContext {
  working:   string[]  // decrypted values, ready for prompt injection
  knowledge: string[]  // highest-value facts
  activeGoals: string[]
  projectContext: string[]
}
