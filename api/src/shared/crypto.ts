/**
 * Symmetric encryption for at-rest secrets (GitHub PATs, future BYOK keys).
 *
 * AES-256-GCM with a single master key loaded from app settings. The
 * `ATLAS_GITHUB_TOKEN_MASTER_KEY` env var must be a 32-byte key encoded as
 * either:
 *   - base64 (44 chars including padding, e.g. `openssl rand -base64 32`)
 *   - hex (64 chars, e.g. `openssl rand -hex 32`)
 *
 * The ciphertext format we emit is a single base64 string with three parts
 * joined by `:`:  `<ivB64>:<authTagB64>:<payloadB64>`. This keeps the schema
 * trivial (one string column on the user doc) and human-inspectable.
 *
 * IMPORTANT: rotating the master key invalidates every previously-encrypted
 * value. There's no key-id baked into the ciphertext today; rotation is
 * "clear all tokens, ask users to re-paste". Documented on the Settings page.
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const ALG = 'aes-256-gcm';
const IV_BYTES = 12; // GCM-recommended

let _key: Buffer | null = null;

function loadKey(): Buffer {
  if (_key) return _key;
  const raw = process.env.ATLAS_GITHUB_TOKEN_MASTER_KEY;
  if (!raw) {
    throw new Error(
      'ATLAS_GITHUB_TOKEN_MASTER_KEY is not set. Generate one with `openssl rand -base64 32` and set it via `az staticwebapp appsettings set`.',
    );
  }
  let buf: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    buf = Buffer.from(raw, 'hex');
  } else {
    try {
      buf = Buffer.from(raw, 'base64');
    } catch {
      throw new Error('ATLAS_GITHUB_TOKEN_MASTER_KEY must be base64 or hex (32 bytes).');
    }
  }
  if (buf.length !== 32) {
    throw new Error(
      `ATLAS_GITHUB_TOKEN_MASTER_KEY must decode to exactly 32 bytes (got ${buf.length}).`,
    );
  }
  _key = buf;
  return buf;
}

/** Encrypt a UTF-8 string. Output is `iv:tag:payload`, each base64. */
export function encryptSecret(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/** Decrypt a ciphertext produced by `encryptSecret`. Throws on tamper / bad key. */
export function decryptSecret(ciphertext: string): string {
  const key = loadKey();
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid ciphertext format (expected iv:tag:payload).');
  }
  const [ivB64, tagB64, payloadB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const payload = Buffer.from(payloadB64, 'base64');
  if (iv.length !== IV_BYTES) {
    throw new Error(`Invalid IV length (got ${iv.length}, expected ${IV_BYTES}).`);
  }
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(payload), decipher.final()]);
  return dec.toString('utf8');
}

/** True when a master key is configured. Used by Settings UI to gate the feature. */
export function isCryptoConfigured(): boolean {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}
