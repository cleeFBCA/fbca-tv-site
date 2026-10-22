// Encryption shared by the crew duties tools. duties.html decrypts the same
// format in the browser with WebCrypto, so the two must stay in step.
//
// A file is a small JSON envelope: the salt and iteration count for turning the
// password into keys, a fresh random IV, and the AES-GCM ciphertext. The first
// 32 bytes PBKDF2 derives are the AES key. The next 32 are an HMAC key, used
// only by the sync job to tell whether the plaintext changed without having to
// decrypt the old file. The browser ignores the MAC.

import { webcrypto as crypto } from 'node:crypto';

export const ITERATIONS = 600000;

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

async function keys(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 512));
  const aes = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const hmac = await crypto.subtle.importKey('raw', bits.slice(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return { aes, hmac };
}

/** Encrypts text. Pass the previous envelope to keep its salt, so its MAC can be compared. */
export async function seal(text, password, previous) {
  const salt = previous?.salt ? unb64(previous.salt) : crypto.getRandomValues(new Uint8Array(16));
  const iterations = previous?.iter ?? ITERATIONS;
  const { aes, hmac } = await keys(password, salt, iterations);
  const data = new TextEncoder().encode(text);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, data);
  const mac = await crypto.subtle.sign('HMAC', hmac, data);
  return { v: 1, iter: iterations, salt: b64(salt), iv: b64(iv), ct: b64(ct), mac: b64(mac) };
}

/** The MAC the text would have under the envelope's salt and password. */
export async function macFor(text, password, envelope) {
  const { hmac } = await keys(password, unb64(envelope.salt), envelope.iter);
  return b64(await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(text)));
}

/** Decrypts an envelope. Throws if the password is wrong. */
export async function open(envelope, password) {
  const { aes } = await keys(password, unb64(envelope.salt), envelope.iter);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(envelope.iv) }, aes, unb64(envelope.ct));
  return new TextDecoder().decode(pt);
}
