// memory/index.js
// PromptForge Memory System — Main Interface
// The only file the rest of the app imports.

import { deriveKey, generateSalt, saltToString, saltFromString } from './encryption.js';
import { MemoryStore } from './store.js';
import { RepetitionDetector } from './repetition.js';
import { Distiller } from './distiller.js';

export class MemoryManager {
  constructor(store, detector, distiller, saltB64) {
    this.store      = store;
    this.detector   = detector;
    this.distiller  = distiller;
    this.saltB64    = saltB64;
    this.pendingOffer = null;
    this.active = {
      conversationSummary: [],
      currentTask: null,
      currentProject: null,
      turnCount: 0,
      startedAt: Date.now(),
    };
  }

  // ── Factory ──────────────────────────────────────────────────────────────────

  static async create(password, apiKey, savedState) {
    const salt = savedState ? saltFromString(savedState.saltB64) : generateSalt();
    const key  = await deriveKey(password, salt);
    const store     = new MemoryStore(key, savedState ?? {});
    const detector  = new RepetitionDetector(savedState?.repetitions ?? []);
    const distiller = new Distiller(apiKey);
    return new MemoryManager(store, detector, distiller, saltToString(salt));
  }

  // ── Session start ────────────────────────────────────────────────────────────

  async getSystemPromptAddition() {
    return this.store.buildSystemPromptAddition();
  }

  // ── During conversation ──────────────────────────────────────────────────────

  processMessage(message, role = 'user') {
    this.active.turnCount++;

    if (role === 'user') {
      const note = message.length > 120 ? message.slice(0, 120) + '…' : message;
      this.active.conversationSummary.push(`User: ${note}`);
      if (this.active.conversationSummary.length > 10) {
        this.active.conversationSummary = this.active.conversationSummary.slice(-6);
      }
    }

    const offer = this.detector.process(message);
    if (offer) this.pendingOffer = offer;
    return offer;
  }

  async handleOfferResponse(accepted) {
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

  async endSession() {
    const extracted = await this.distiller.extract(this.active);
    let didExtract = false;
    if (extracted) {
      await this.store.ingestExtracted(extracted);
      didExtract = true;
    }
    const stats = this.store.compress();
    return { extracted: didExtract, ...stats };
  }

  // ── User controls ────────────────────────────────────────────────────────────

  async inspect()    { return this.store.inspect(); }
  forget(id)         { this.store.delete(id); }
  forgetEverything() { this.store.deleteAll(); this.detector.clear(); }

  // ── Export ───────────────────────────────────────────────────────────────────

  export(userId) {
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
