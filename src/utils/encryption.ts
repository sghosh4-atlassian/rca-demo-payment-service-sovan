import crypto from 'crypto';
import { config } from '../config';

const ALGORITHM = 'aes-256-cbc';
const KEY = Buffer.from(config.encryption.key, 'utf8').slice(0, 32);
const IV = Buffer.from(config.encryption.iv, 'utf8').slice(0, 16);

/**
 * Encrypts a plain-text string using AES-256-CBC.
 */
export function encrypt(text: string): string {
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, IV);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
}

/**
 * Decrypts an AES-256-CBC encrypted hex string.
 */
export function decrypt(encryptedText: string): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, IV);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Generates a cryptographically secure random token.
 */
export function generateSecureToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Hashes a value using SHA-256 (one-way, for webhook signatures etc.)
 */
export function sha256Hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Creates an HMAC-SHA256 signature for webhook payloads.
 */
export function createWebhookSignature(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
export function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Masks a card number, leaving only the last 4 digits visible.
 * e.g. "4242424242424242" → "************4242"
 */
export function maskCardNumber(cardNumber: string): string {
  const cleaned = cardNumber.replace(/\s/g, '');
  return '*'.repeat(cleaned.length - 4) + cleaned.slice(-4);
}
