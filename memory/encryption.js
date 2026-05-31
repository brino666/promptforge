// memory/encryption.js
// PromptForge Memory System — Encryption (Node.js compatible)

import { webcrypto } from 'crypto';
const subtle = webcrypto.subtle;
const IV_LENGTH = 12;
const PBKDF2_ITERATIONS = 310_000;

export async function deriveKey(password, salt) {
  const enc = new TextEncoder();
  const base = await subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
  );
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export function generateSalt() {
  return webcrypto.getRandomValues(new Uint8Array(16));
}

export function saltToString(salt) {
  return Buffer.from(salt).toString('base64');
}

export function saltFromString(s) {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

export async function encryptValue(value, key) {
  const iv = webcrypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const data = new TextEncoder().encode(value);
  const cipher = await subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(cipher), iv.length);
  return Buffer.from(combined).toString('base64');
}

export async function decryptValue(encrypted, key) {
  const combined = new Uint8Array(Buffer.from(encrypted, 'base64'));
  const iv = combined.slice(0, IV_LENGTH);
  const cipher = combined.slice(IV_LENGTH);
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return new TextDecoder().decode(plain);
}
