// memory/repetition.ts
// PromptForge Memory System v2 — Repetition Detection
// Unchanged from v1 — this logic is solid.
// Still the ONLY trigger for memory offers.
// "I can remember that if you like." — one offer, never repeated if declined.

import type { RepetitionRecord, MemoryOffer } from './types.js';

const REPETITION_THRESHOLD = 3;

const NOISE = new Set([
  'yes','no','ok','okay','thanks','thank you','sure','please',
  'help','stop','continue','good','great','fine','got it','i see',
]);

export function normalizePhrase(input: string): string {
  return input
    .toLowerCase().trim()
    .replace(/[^\w\s]/g, '')
    .replace(/\b(i|me|my|always|usually|prefer|like|want|use)\b/g, '')
    .replace(/\s+/g, ' ').trim();
}

export function extractPreferencePhrases(message: string): string[] {
  const patterns = [
    /i (?:always|usually|prefer|like to|want to|tend to) (.+?)(?:\.|,|$)/gi,
    /(?:always|usually|prefer) (.+?)(?:\.|,|$)/gi,
    /keep (?:it|responses?|answers?) (.+?)(?:\.|,|$)/gi,
    /(?:use|using) (.+?) (?:for|when|instead)/gi,
    /i work (.+?)(?:\.|,|$)/gi,
  ];
  const phrases: string[] = [];
  for (const p of patterns) {
    for (const m of message.matchAll(p)) {
      const phrase = normalizePhrase(m[0]);
      if (phrase.length > 3 && phrase.length < 80 && !NOISE.has(phrase)) {
        phrases.push(phrase);
      }
    }
  }
  return [...new Set(phrases)];
}

export class RepetitionDetector {
  private records: Map<string, RepetitionRecord>;

  constructor(saved?: [string, RepetitionRecord][]) {
    this.records = new Map(saved ?? []);
  }

  process(message: string): MemoryOffer | null {
    for (const phrase of extractPreferencePhrases(message)) {
      const offer = this.recordPhrase(phrase);
      if (offer) return offer;
    }
    return null;
  }

  private recordPhrase(normalized: string): MemoryOffer | null {
    const now = Date.now();
    const existing = this.records.get(normalized);

    if (!existing) {
      this.records.set(normalized, { normalized, count: 1, firstSeen: now, lastSeen: now, offered: false, declined: false });
      return null;
    }
    if (existing.declined || existing.offered) return null;

    existing.count += 1;
    existing.lastSeen = now;

    if (existing.count >= REPETITION_THRESHOLD) {
      existing.offered = true;
      this.records.set(normalized, existing);
      return {
        shouldOffer: true,
        phrase: normalized,
        message: 'I can remember that if you like.',
      };
    }

    this.records.set(normalized, existing);
    return null;
  }

  accept(phrase: string): void {
    const r = this.records.get(phrase);
    if (r) { r.offered = true; r.declined = false; this.records.set(phrase, r); }
  }

  decline(phrase: string): void {
    const r = this.records.get(phrase);
    if (r) { r.declined = true; this.records.set(phrase, r); }
  }

  serialize(): [string, RepetitionRecord][] {
    return [...this.records.entries()];
  }

  clear(): void { this.records.clear(); }
}
