// memory/store.ts
// PromptForge Memory System v2 — Four-Tier Store
//
// Manages Working, Archive, and Knowledge tiers.
// Active tier lives in RAM only (MemoryManager handles it).
// All stored values are encrypted.

import { randomUUID } from 'crypto';
import type {
  MemoryEntry,
  MemoryTier,
  PersistedMemoryState,
  MemoryContext,
  ExtractedKnowledge,
  RepetitionRecord,
} from './types.js';
import { TIER_BUDGETS, SCORE_THRESHOLDS } from './types.js';
import {
  scoreEntry,
  decideTier,
  enforcebudget,
  applyDecay,
  estimateBytes,
} from './scorer.js';
import { encryptValue, decryptValue } from './encryption.js';

export class MemoryStore {
  private working:   Map<string, MemoryEntry>;
  private archive:   Map<string, MemoryEntry>;
  private knowledge: Map<string, MemoryEntry>;
  private key: CryptoKey;

  constructor(key: CryptoKey, state?: Partial<PersistedMemoryState>) {
    this.key = key;
    this.working   = new Map((state?.working   ?? []).map((e) => [e.id, e]));
    this.archive   = new Map((state?.archive   ?? []).map((e) => [e.id, e]));
    this.knowledge = new Map((state?.knowledge ?? []).map((e) => [e.id, e]));
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  /**
   * Save a new entry to the working tier.
   * If a similar entry exists, reinforce it instead.
   */
  async save(params: {
    pattern: string
    value: string
    utility: string
    importance: number
    userVerified?: boolean
  }): Promise<MemoryEntry> {
    const { pattern, value, utility, importance, userVerified = false } = params;

    // Check for existing similar entry
    const existing = this.findSimilar(pattern);
    if (existing) return this.reinforce(existing.id, value);

    const encrypted = await encryptValue(value, this.key);
    const now = Date.now();

    const entry: MemoryEntry = {
      id: randomUUID(),
      tier: 'working',
      pattern,
      value: '',         // never stored in plain text
      utility,
      score: {
        recency:    1.0,
        frequency:  0.05,
        importance,
        confirmed:  userVerified ? 1 : 0,
        total:      0,
      },
      createdAt: now,
      lastUsed: now,
      useCount: 1,
      userVerified,
      userDeclined: false,
      deletable: true,
      mergedFrom: [],
      sourceTier: null,
      encryptedValue: encrypted,
    };

    // Calculate initial score
    entry.score = scoreEntry(entry, now);

    this.working.set(entry.id, entry);
    return entry;
  }

  /**
   * Reinforce an existing entry — more uses = higher score.
   */
  async reinforce(id: string, newValue?: string): Promise<MemoryEntry> {
    const entry = this.getById(id);
    if (!entry) throw new Error(`Memory entry ${id} not found`);

    entry.useCount += 1;
    entry.lastUsed = Date.now();
    if (newValue) {
      entry.encryptedValue = await encryptValue(newValue, this.key);
    }
    entry.score = scoreEntry(entry);

    this.setInTier(entry);
    return entry;
  }

  /**
   * Promote extracted knowledge from distillation into the store.
   * High-confidence items go straight to knowledge tier.
   * Lower-confidence items go to working tier.
   */
  async ingestExtracted(extracted: ExtractedKnowledge): Promise<void> {
    const now = Date.now();

    for (const pref of extracted.preferences) {
      await this.save({
        pattern: pref.pattern,
        value: pref.value,
        utility: 'User preference',
        importance: pref.confidence,
      });
    }

    for (const goal of extracted.goals.filter((g) => g.status === 'active')) {
      await this.save({
        pattern: `Goal: ${goal.description}`,
        value: goal.description,
        utility: 'Active goal context',
        importance: goal.confidence,
      });
    }

    for (const pattern of extracted.patterns) {
      await this.save({
        pattern: pattern.observation,
        value: pattern.observation,
        utility: 'Behavioral pattern',
        importance: pattern.confidence,
      });
    }

    for (const ctx of extracted.projectContext) {
      await this.save({
        pattern: `Project: ${ctx.project}`,
        value: ctx.state,
        utility: 'Project context',
        importance: ctx.confidence,
      });
    }
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  /**
   * Build the memory context for injection at session start.
   * Decrypts only what's needed — working + knowledge tiers.
   */
  async buildContext(): Promise<MemoryContext> {
    const now = Date.now();
    const context: MemoryContext = {
      working: [],
      knowledge: [],
      activeGoals: [],
      projectContext: [],
    };

    // Working tier — recent preferences and active context
    for (const entry of this.working.values()) {
      entry.lastUsed = now;
      entry.useCount += 1;
      entry.score = scoreEntry(entry, now);
      this.working.set(entry.id, entry);

      const value = await decryptValue(entry.encryptedValue, this.key);

      if (entry.utility.includes('goal')) {
        context.activeGoals.push(value);
      } else if (entry.utility.includes('Project')) {
        context.projectContext.push(value);
      } else {
        context.working.push(value);
      }
    }

    // Knowledge tier — high-confidence permanent facts
    for (const entry of this.knowledge.values()) {
      const value = await decryptValue(entry.encryptedValue, this.key);
      context.knowledge.push(value);
    }

    return context;
  }

  /**
   * Format context as a system prompt addition.
   * Called before each Claude API request.
   */
  async buildSystemPromptAddition(): Promise<string> {
    const ctx = await this.buildContext();
    const sections: string[] = [];

    if (ctx.knowledge.length > 0) {
      sections.push(`What I know about you:\n${ctx.knowledge.map((v) => `- ${v}`).join('\n')}`);
    }
    if (ctx.working.length > 0) {
      sections.push(`Your preferences:\n${ctx.working.map((v) => `- ${v}`).join('\n')}`);
    }
    if (ctx.activeGoals.length > 0) {
      sections.push(`Active goals:\n${ctx.activeGoals.map((v) => `- ${v}`).join('\n')}`);
    }
    if (ctx.projectContext.length > 0) {
      sections.push(`Project context:\n${ctx.projectContext.map((v) => `- ${v}`).join('\n')}`);
    }

    if (sections.length === 0) return '';

    return ['---', ...sections, '---'].join('\n');
  }

  /**
   * Returns all entries for the user-facing memory inspector.
   */
  async inspect(): Promise<Array<{
    id: string
    tier: MemoryTier
    pattern: string
    utility: string
    score: number
    lastUsed: number
    useCount: number
    userVerified: boolean
    value: string
  }>> {
    const all = [
      ...this.working.values(),
      ...this.archive.values(),
      ...this.knowledge.values(),
    ];

    return Promise.all(
      all.map(async (e) => ({
        id: e.id,
        tier: e.tier,
        pattern: e.pattern,
        utility: e.utility,
        score: e.score.total,
        lastUsed: e.lastUsed,
        useCount: e.useCount,
        userVerified: e.userVerified,
        value: await decryptValue(e.encryptedValue, this.key),
      }))
    );
  }

  // ── Delete ──────────────────────────────────────────────────────────────────

  delete(id: string): void {
    this.working.delete(id);
    this.archive.delete(id);
    this.knowledge.delete(id);
  }

  deleteAll(): void {
    this.working.clear();
    this.archive.clear();
    this.knowledge.clear();
  }

  // ── Compression pipeline ─────────────────────────────────────────────────────

  /**
   * Run the full compression pipeline.
   * 1. Refresh all scores with recency decay
   * 2. Promote high-value working entries to knowledge
   * 3. Compress low-value working entries to archive
   * 4. Delete entries below deletion threshold
   * 5. Enforce tier budgets
   */
  compress(): { promoted: number; compressed: number; deleted: number } {
    const now = Date.now();
    let promoted = 0, compressed = 0, deleted = 0;

    // Step 1: Refresh scores
    const refreshed = (entries: Map<string, MemoryEntry>) => {
      for (const [id, entry] of entries) {
        entries.set(id, { ...entry, score: scoreEntry(entry, now) });
      }
    };
    refreshed(this.working);
    refreshed(this.archive);
    refreshed(this.knowledge);

    // Step 2-4: Process working tier
    for (const [id, entry] of this.working) {
      const decision = decideTier(entry);
      if (decision === 'promote') {
        this.working.delete(id);
        this.knowledge.set(id, { ...entry, tier: 'knowledge', sourceTier: 'working' });
        promoted++;
      } else if (decision === 'compress') {
        this.working.delete(id);
        this.archive.set(id, { ...entry, tier: 'archive', sourceTier: 'working' });
        compressed++;
      } else if (decision === 'delete') {
        this.working.delete(id);
        deleted++;
      }
    }

    // Step 5: Enforce budgets
    this.working   = toMap(enforcebudget([...this.working.values()],   TIER_BUDGETS.working));
    this.archive   = toMap(enforcebudget([...this.archive.values()],   TIER_BUDGETS.archive));
    this.knowledge = toMap(enforcebudget([...this.knowledge.values()], TIER_BUDGETS.knowledge));

    return { promoted, compressed, deleted };
  }

  // ── Serialization ────────────────────────────────────────────────────────────

  serialize(): Pick<PersistedMemoryState, 'working' | 'archive' | 'knowledge'> {
    return {
      working:   [...this.working.values()],
      archive:   [...this.archive.values()],
      knowledge: [...this.knowledge.values()],
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private findSimilar(pattern: string): MemoryEntry | null {
    const norm = pattern.toLowerCase().trim();
    for (const tier of [this.working, this.knowledge, this.archive]) {
      for (const entry of tier.values()) {
        if (entry.pattern.toLowerCase().trim() === norm) return entry;
      }
    }
    return null;
  }

  private getById(id: string): MemoryEntry | null {
    return (
      this.working.get(id) ??
      this.archive.get(id) ??
      this.knowledge.get(id) ??
      null
    );
  }

  private setInTier(entry: MemoryEntry): void {
    const map = entry.tier === 'working'   ? this.working
              : entry.tier === 'archive'   ? this.archive
              : this.knowledge;
    map.set(entry.id, entry);
  }
}

function toMap(entries: MemoryEntry[]): Map<string, MemoryEntry> {
  return new Map(entries.map((e) => [e.id, e]));
  }
