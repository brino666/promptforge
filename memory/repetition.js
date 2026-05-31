// memory/repetition.js
// PromptForge Memory System — Repetition Detection
// The ONLY trigger for memory offers.
// "I can remember that if you like." — once, never again if declined.

const REPETITION_THRESHOLD = 3;

const NOISE = new Set([
  'yes','no','ok','okay','thanks','thank you','sure','please',
  'help','stop','continue','good','great','fine','got it','i see',
]);

export function normalizePhrase(input) {
  return input
    .toLowerCase().trim()
    .replace(/[^\w\s]/g, '')
    .replace(/\b(i|me|my|always|usually|prefer|like|want|use)\b/g, '')
    .replace(/\s+/g, ' ').trim();
}

export function extractPreferencePhrases(message) {
  const patterns = [
    /i (?:always|usually|prefer|like to|want to|tend to) (.+?)(?:\.|,|$)/gi,
    /(?:always|usually|prefer) (.+?)(?:\.|,|$)/gi,
    /keep (?:it|responses?|answers?) (.+?)(?:\.|,|$)/gi,
    /(?:use|using) (.+?) (?:for|when|instead)/gi,
    /i work (.+?)(?:\.|,|$)/gi,
  ];
  const phrases = [];
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
  constructor(saved = []) {
    this.records = new Map(saved);
  }

  process(message) {
    for (const phrase of extractPreferencePhrases(message)) {
      const offer = this.recordPhrase(phrase);
      if (offer) return offer;
    }
    return null;
  }

  recordPhrase(normalized) {
    const now = Date.now();
    const existing = this.records.get(normalized);

    if (!existing) {
      this.records.set(normalized, {
        normalized, count: 1,
        firstSeen: now, lastSeen: now,
        offered: false, declined: false,
      });
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

  accept(phrase) {
    const r = this.records.get(phrase);
    if (r) { r.offered = true; r.declined = false; this.records.set(phrase, r); }
  }

  decline(phrase) {
    const r = this.records.get(phrase);
    if (r) { r.declined = true; this.records.set(phrase, r); }
  }

  serialize() { return [...this.records.entries()]; }
  clear()     { this.records.clear(); }
}
