import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config';

// AES-256-GCM. Stored text looks like  v1.<iv>.<authTag>.<ciphertext>  (base64 parts).
// GCM also detects tampering: decrypting a changed value throws.
const keyBytes = () => Buffer.from(config.DATA_ENCRYPTION_KEY, 'hex'); // 64 hex chars = 32 bytes

export function encryptField(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

export function decryptField(stored: string): string {
  const [version, iv, tag, data] = stored.split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unrecognised encrypted value');
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}