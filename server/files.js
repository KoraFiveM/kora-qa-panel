// Attachment storage under DATA_DIR/files and signed file tokens (HMAC of the id, 7-day validity) so the fixer can fetch
// attachment URLs from GET /bug/:id without a session.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export const TOKEN_TTL = 7 * 24 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;
export const MIME_EXT = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest();

// Expiry rounded up to a whole day so the same URL is handed out for a day (stable /bug/:id output within a day).
export function signFileToken(id, { now = Date.now(), secret = config().sessionSecret } = {}) {
  const exp = Math.ceil((now + TOKEN_TTL) / DAY) * DAY;
  return `${exp.toString(36)}.${b64url(hmac(secret, `file:${id}:${exp}`)).slice(0, 32)}`;
}

export function verifyFileToken(id, token, { now = Date.now(), secret = config().sessionSecret } = {}) {
  const m = /^([0-9a-z]+)\.([A-Za-z0-9_-]{32})$/.exec(String(token ?? ''));
  if (!m) return false;
  const exp = parseInt(m[1], 36);
  if (!Number.isFinite(exp) || exp < now || exp > now + TOKEN_TTL + DAY) return false;
  const want = Buffer.from(b64url(hmac(secret, `file:${id}:${exp}`)).slice(0, 32));
  const got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

export const fileUrl = (id, base = config().publicUrl) => `${base}/files/${id}?t=${signFileToken(id)}`;

// Detects the image type from magic bytes (never trust the Content-Type alone).
export function sniffImage(buf) {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  return null;
}

// Writes the buffer, returns { rel, abs }. rel is relative to filesDir (what issue_attachments.path stores).
export function storeFile(buf, mime, { dir = config().filesDir, now = new Date() } = {}) {
  const ext = MIME_EXT[mime] ?? 'bin';
  const sub = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const rel = `${sub}/${crypto.randomBytes(12).toString('hex')}.${ext}`;
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf, { mode: 0o640 });
  return { rel, abs };
}

// Absolute path for a stored rel path, refusing anything that escapes filesDir.
export function filePath(rel, dir = config().filesDir) {
  const abs = path.resolve(dir, String(rel));
  if (!abs.startsWith(path.resolve(dir) + path.sep)) return null;
  return abs;
}
