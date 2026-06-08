'use strict';
/**
 * PCI-DSS Layer 3: Card tokenization
 *
 * Raw card numbers must NEVER be stored or logged.
 * This module extracts the safe parts (BIN + last4 + network) and
 * produces a one-time token that maps back to the card in a secure vault.
 *
 * In production: replace the in-memory map with an HSM or a dedicated
 * vault service (HashiCorp Vault, AWS CloudHSM, etc.).
 */
const { randomUUID, createCipheriv, createDecipheriv, randomBytes } = require('crypto');

const ALGO      = 'aes-256-gcm';
const VAULT_KEY = (process.env.CARD_VAULT_KEY ?? '').padEnd(32, '0').slice(0, 32); // 32-byte key

// In-memory vault (dev/test only) — swap for persistent encrypted store in prod
const _vault = new Map();

function detectNetwork(cardNumber) {
  const n = cardNumber.replace(/\s/g, '');
  if (/^4/.test(n))                      return 'visa';
  if (/^5[1-5]/.test(n))                 return 'mastercard';
  if (/^3[47]/.test(n))                  return 'amex';
  if (/^6(?:011|5)/.test(n))             return 'discover';
  if (/^35(?:2[89]|[3-8])/.test(n))      return 'jcb';
  if (/^(?:6304|6759|6761|6763)/.test(n)) return 'maestro';
  if (/^(?:508[5-9]|6069|607|608|65)/.test(n)) return 'rupay';
  return 'unknown';
}

function encrypt(plaintext) {
  const iv  = randomBytes(12);
  const key = Buffer.from(VAULT_KEY);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(ciphertext) {
  const [ivHex, tagHex, dataHex] = ciphertext.split(':');
  const decipher = createDecipheriv(ALGO, Buffer.from(VAULT_KEY), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

/**
 * Tokenize a raw card number.
 * Returns a token + safe display fields. Raw number is never returned again.
 */
function tokenizeCard(cardNumber) {
  const clean   = cardNumber.replace(/\s|-/g, '');
  const token   = 'ctok_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const bin     = clean.slice(0, 6);
  const last4   = clean.slice(-4);
  const network = detectNetwork(clean);

  // Store encrypted card in vault (production: persist to HSM/vault service)
  _vault.set(token, encrypt(clean));

  return { token, bin, last4, network };
}

/**
 * Retrieve raw card from vault — only for charge processing.
 * Returns null if token not found or decryption fails.
 */
function detokenizeCard(token) {
  const enc = _vault.get(token);
  if (!enc) return null;
  try { return decrypt(enc); } catch { return null; }
}

function isCardToken(value) {
  return typeof value === 'string' && value.startsWith('ctok_');
}

module.exports = { tokenizeCard, detokenizeCard, isCardToken, detectNetwork };
