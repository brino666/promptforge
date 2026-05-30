// memory/index.ts
// PromptForge Memory System v2 — Main Interface
//
// The only file the rest of the app imports.
// Implements the full distillation pipeline:
//
//   Conversation → Extract Meaning → Update Knowledge
//   → Compress History → Retain Conclusions

import {
  deriveKey,
  generateSalt,
  saltToString,
  saltFromString,
} from './encryption.js';
import { MemoryStore } from './store.js';
import { RepetitionDetector } from './repetition.js';
import { Distiller } from './distiller.js';
import type {
  PersistedMemoryState,
  ActiveMemory,
  MemoryOffer,
} from './types.js';

export class MemoryManager {
  private store: MemoryStore;
  private detector: RepetitionDetector;
  private distiller: Distiller;
  private active: ActiveMemory;
  private pendingOffer: MemoryOffer | null = null;
  private saltB64: string;

  private constructor(
    store: MemoryStore,
    detector: RepetitionDetector,
    distiller: Distiller,
    saltB64: string
  ) {
    this.store = store;
    this.detector = detector;
    this.distiller = distiller;
    this.saltB64 = saltB64;
    this.active = {
      conversationSummary: [],
      currentTask: null,
      currentProject: null,
      turnCount: 0,
      startedAt: Date.now(),
    };
  }

  // ── Factory ──────────────────────────────────────────────────────────────────

  static async create(
    password: string,
    apiKey: string,
    savedState: PersistedMemoryState | null
  ): Promise<MemoryManager> {
    const salt = savedState
      ? saltFromString(savedState.saltB64)
      : generateSalt();

    const key = await deriveKey(password, salt);
    const store = new MemoryStore(key, savedState ?? {});
    const detector = new RepetitionDetector(savedState?.repetitions ?? []);
    const distiller = new Distiller(apiKey);

    return new MemoryManager(store, detector, distiller, saltToString(salt));
  }

  // ── Session start ────────────────────────────────────────────────────────────

  /** Get the system prompt addition — inject this into every Claude call */
  async getSystemPromptAddition(): Promise<string> {
    return this.store.buildSystemPromptAddition();
  }

  // ── During conversation ──────────────────────────────────────────────────────

  /**
   * Call this on every user message.
   * Returns a MemoryOffer if the repetition threshold is crossed.
   * Append offer.message to the assistant response if returned.
   */
  processMessage(message: string, role: 'user' | 'assistant' = 'user'): MemoryOffer | null {
    // Track conversation for end-of-session distillation
    this.active.turnCount++;
    if (role === 'user') {
      // Add compressed note to summary (not the raw message)
      const note = message.length > 120
        ? message.slice(0, 120) + '…'
        : message;
      this.active.conversationSummary.push(`User: ${note}`);

      // Keep summary bounded — compress if it grows too long
      if (this.active.conversationSummary.length > 10) {
        this.active.conversationSummary = this.active.conversationSummary.slice(-6);
      }
    }

    // Rule-based repetition detection
    const offer = this.detector.process(message);
    if (offer) this.pendingOffer = offer;
    return offer;
  }

  /** User responded to a memory offer */
  async handleOfferResponse(accepted: boolean): Promise<void> {
    if (!this.pendingOffer) return;

    if (accepted) {
      this.detector.accept(this.pendingOffer.phrase);
      await this.store.save({
        pattern: this.pendingOffer.phrase,
        value: this.pendingOffer.phrase,
        utility: 'User-confirmed preference',
        importance: 1.0,
        userVerified: true,
      });
    } else {
      this.detector.decline(this.pendingOffer.phrase);
    }
    this.pendingOffer = null;
  }

  // ── Session end ──────────────────────────────────────────────────────────────

  /**
   * Run at the end of every session.
   * 1. Claude extracts knowledge from conversation (Option C — Claude half)
   * 2. Ingests extracted knowledge into store
   * 3. Runs compression pipeline
   * Returns stats for logging.
   */
  async endSession(): Promise<{
    extracted: boolean
    promoted: number
    compressed: number
    deleted: number
  }> {
    // Step 1: Claude-powered extraction
    const extracted = await this.distiller.extract(this.active);
    let didExtract = false;

    // Step 2: Ingest extracted knowledge
    if (extracted) {
      await this.store.ingestExtracted(extracted);
      didExtract = true;
    }

    // Step 3: Compression pipeline
    const stats = this.store.compress();

    return { extracted: didExtract, ...stats };
  }

  // ── User controls ────────────────────────────────────────────────────────────

  async inspect()            { return this.store.inspect(); }
  forget(id: string)         { this.store.delete(id); }
  forgetEverything()         { this.store.deleteAll(); this.detector.clear(); }

  // ── Export for persistence ───────────────────────────────────────────────────

  export(userId: string): PersistedMemoryState {
    return {
      userId,
      saltB64: this.saltB64,
      ...this.store.serialize(),
      repetitions: this.detector.serialize(),
      lastCompressed: Date.now(),
      version: 2,
    };
  }
}

// Re-export types
export type { PersistedMemoryState, MemoryOffer };
