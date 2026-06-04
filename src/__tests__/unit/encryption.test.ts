import {
  encrypt,
  decrypt,
  generateSecureToken,
  sha256Hash,
  createWebhookSignature,
  safeCompare,
  maskCardNumber,
} from '../../utils/encryption';

describe('encryption utils', () => {
  describe('encrypt / decrypt', () => {
    it('encrypts and decrypts a string correctly', () => {
      const plaintext = 'sensitive-payment-data-4242';
      const encrypted = encrypt(plaintext);
      expect(encrypted).not.toBe(plaintext);
      expect(decrypt(encrypted)).toBe(plaintext);
    });

    it('produces different output for different inputs', () => {
      expect(encrypt('hello')).not.toBe(encrypt('world'));
    });
  });

  describe('generateSecureToken', () => {
    it('generates a hex token of the correct length', () => {
      const token = generateSecureToken(32);
      expect(token).toHaveLength(64); // 32 bytes = 64 hex chars
    });

    it('generates unique tokens each time', () => {
      expect(generateSecureToken()).not.toBe(generateSecureToken());
    });
  });

  describe('sha256Hash', () => {
    it('returns a consistent 64-char hex hash', () => {
      const hash = sha256Hash('test-value');
      expect(hash).toHaveLength(64);
      expect(sha256Hash('test-value')).toBe(hash); // deterministic
    });
  });

  describe('createWebhookSignature', () => {
    it('creates an HMAC-SHA256 signature', () => {
      const sig = createWebhookSignature('{"event":"payment.completed"}', 'my-secret');
      expect(sig).toHaveLength(64);
    });

    it('produces different signatures for different secrets', () => {
      const payload = '{"event":"test"}';
      expect(createWebhookSignature(payload, 'secret-a')).not.toBe(
        createWebhookSignature(payload, 'secret-b'),
      );
    });
  });

  describe('safeCompare', () => {
    it('returns true for identical strings', () => {
      expect(safeCompare('abc123', 'abc123')).toBe(true);
    });

    it('returns false for different strings of same length', () => {
      expect(safeCompare('abc123', 'xyz789')).toBe(false);
    });

    it('returns false for strings of different lengths', () => {
      expect(safeCompare('short', 'muchlongerstring')).toBe(false);
    });
  });

  describe('maskCardNumber', () => {
    it('masks all but last 4 digits', () => {
      expect(maskCardNumber('4242424242424242')).toBe('************4242');
    });

    it('handles card numbers with spaces', () => {
      expect(maskCardNumber('4242 4242 4242 4242')).toBe('************4242');
    });
  });
});
