// memory/store.js
// PromptForge Memory System — Four-Tier Store

import { randomUUID } from 'crypto';
import { TIER_BUDGETS, SCORE_THRESHOLDS } from './types.js';
import { scoreEntry, decideTier, enforceBudget } from './scorer.js';
import { encryptValue, decryptValue } from './encryption.js';

function toMap(entries) {
  return new Map(entries.map((e) => [e.id, e]));
}

export class MemoryStore {
  constructor(key, state = {}) {
    this.key      = key;
    this.working   = new Map((state.working   ?? []).map((e) => [e.id, e]));
    this.archive   = new Map((state.archive   ?? []).map((e) => [e.id, e]));
    this.knowledge = new Map((state.knowledge ?? []).map((e) => [e.id, e]));
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  async save({ pattern, value, utility, importance, userVerified = false }) {
    const existing = this.findSimilar(pattern);
    if (existing) return this.reinforce(existing.id, value);

    const encrypted = await encryptValue(value, this.key);
    const now = Date.now();

    const entry = {
      id: randomUUID(),
      tier: 'working',
      pattern,
      utility,
      score: { recency: 1.0, frequency: 0.05, importance, confirmed: userVerified ? 1 : 0, total: 0 },
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

    entry.score = scoreEntry(entry, now);
    this.working.set(entry.id, entry);
    return entry;
  }

  async reinforce(id, newValue) {
    const entry = this.getById(id);
    if (!entry) throw new Error(`Memory entry ${id} not found`);
    entry.useCount += 1;
    entry.lastUsed = Date.now();
    if (newValue) entry.encryptedValue = await encryptValue(newValue, this.key);
    entry.score = scoreEntry(entry);
    this.setInTier(entry);
    return entry;
  }

  async ingestExtracted(extracted) {
    for (const p of extracted.preferences) {
      await this.save({ pattern: p.pattern, value: p.value, utility: 'User preference', importance: p.confidence });
    }
    for (const g of extracted.goals.filter((g) => g.status === 'active')) {
      await this.save({ pattern: `Goal: ${g.description}`, value: g.description, utility: 'Active goal context', importance: g.confidence });
    }
    for (const p of extracted.patterns) {
      await this.save({ pattern: p.observation, value: p.observation, utility: 'Behavioral pattern', importance: p.confidence });
    }
    for (const c of extracted.projectContext) {
      await this.save({ pattern: `Project: ${c.project}`, value: c.state, utility: 'Project context', importance: c.confidence });
    }
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  async buildSystemPromptAddition() {
    const now = Date.now();
    const sections = [];

    const knowledgeValues = [];
    for (const entry of this.knowledge.values()) {
      knowledgeValues.push(await decryptValue(entry.encryptedValue, this.key));
    }

    const workingValues = [], goals = [], projects = [];
    for (const entry of this.working.values()) {
      entry.lastUsed = now;
      entry.useCount += 1;
      entry.score = scoreEntry(entry, now);
      this.working.set(entry.id, entry);

      const val = await decryptValue(entry.encryptedValue, this.key);
      if (entry.utility.includes('goal'))    goals.push(val);
      else if (entry.utility.includes('Project')) projects.push(val);
      else workingValues.push(val);
    }

    if (knowledgeValues.length > 0)
      sections.push(`What I know about you:\n${knowledgeValues.map((v) => `- ${v}`).join('\n')}`);
    if (workingValues.length > 0)
      sections.push(`Your preferences:\n${workingValues.map((v) => `- ${v}`).join('\n')}`);
    if (goals.length > 0)
      sections.push(`Active goals:\n${goals.map((v) => `- ${v}`).join('\n')}`);
    if (projects.length > 0)
      sections.push(`Project context:\n${projects.map((v) => `- ${v}`).join('\n')}`);

    return sections.length === 0 ? '' : ['---', ...sections, '---'].join('\n');
  }

  async inspect() {
    const all = [...this.working.values(), ...this.archive.values(), ...this.knowledge.values()];
    return Promise.all(all.map(async (e) => ({
      id: e.id,
      tier: e.tier,
      pattern: e.pattern,
      utility: e.utility,
      score: e.score.total,
      lastUsed: e.lastUsed,
      useCount: e.useCount,
      userVerified: e.userVerified,
      value: await decryptValue(e.encryptedValue, this.key),
    })));
  }

  // ── Delete ──────────────────────────────────────────────────────────────────

  delete(id)    { this.working.delete(id); this.archive.delete(id); this.knowledge.delete(id); }
  deleteAll()   { this.working.clear(); this.archive.clear(); this.knowledge.clear(); }

  // ── Compression ─────────────────────────────────────────────────────────────

  compress() {
    const now = Date.now();
    let promoted = 0, compressed = 0, deleted = 0;

    // Refresh scores
    for (const [id, e] of this.working)   this.working.set(id,   { ...e, score: scoreEntry(e, now) });
    for (const [id, e] of this.archive)   this.archive.set(id,   { ...e, score: scoreEntry(e, now) });
    for (const [id, e] of this.knowledge) this.knowledge.set(id, { ...e, score: scoreEntry(e, now) });

    // Process working tier
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

    // Enforce budgets
    this.working   = toMap(enforceBudget([...this.working.values()],   TIER_BUDGETS.working));
    this.archive   = toMap(enforceBudget([...this.archive.values()],   TIER_BUDGETS.archive));
    this.knowledge = toMap(enforceBudget([...this.knowledge.values()], TIER_BUDGETS.knowledge));

    return { promoted, compressed, deleted };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  findSimilar(pattern) {
    const norm = pattern.toLowerCase().trim();
    for (const tier of [this.working, this.knowledge, this.archive]) {
      for (const entry of tier.values()) {
        if (entry.pattern.toLowerCase().trim() === norm) return entry;
      }
    }
    return null;
  }

  getById(id) {
    return this.working.get(id) ?? this.archive.get(id) ?? this.knowledge.get(id) ?? null;
  }

  setInTier(entry) {
    const map = entry.tier === 'working' ? this.working
              : entry.tier === 'archive' ? this.archive
              : this.knowledge;
    map.set(entry.id, entry);
  }

  serialize() {
    return {
      working:   [...this.working.values()],
      archive:   [...this.archive.values()],
      knowledge: [...this.knowledge.values()],
    };
  }
}
