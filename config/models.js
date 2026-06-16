// config/models.js
// Thais — Model configuration
// Centralizes model identifiers so providers/models can be swapped in one place
// (Constitution Principle 9: Modular Intelligence).

export const MODEL_MAIN = process.env.THAIS_MODEL_MAIN || 'claude-sonnet-4-6';
export const MODEL_FAST = process.env.THAIS_MODEL_FAST || 'claude-haiku-4-5-20251001';
