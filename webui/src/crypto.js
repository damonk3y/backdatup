const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

function loadMasterKey() {
  const raw = process.env.BACKDATUP_MASTER_KEY;
  if (!raw) {
    throw new Error(
      'BACKDATUP_MASTER_KEY is not set. Generate one with `bun run gen-master-key` and set it in your environment before starting the server.'
    );
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new Error('BACKDATUP_MASTER_KEY must be a valid base64 string');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `BACKDATUP_MASTER_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}). Generate a fresh one with \`bun run gen-master-key\`.`
    );
  }
  return key;
}

const MASTER_KEY = loadMasterKey();

function encrypt(plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, MASTER_KEY, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag };
}

function decrypt({ ciphertext, iv, tag }) {
  const decipher = crypto.createDecipheriv(ALGORITHM, MASTER_KEY, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

module.exports = { encrypt, decrypt };
