// memory/encryption.js
// Memory System — Encryption (Node.js compatible)

import { webcrypto } from 'crypto';
const subtle = webcrypto.subtle;
const IV_LENGTH = 12;
const PBKDF2_ITERATIONS = 310_000;