// memory/index.js
// Memory System — Main Interface

import { deriveKey, generateSalt, saltToString, saltFromString } from './encryption.js';
import { MemoryStore } from './store.js';
import { RepetitionDetector } from './repetition.js';