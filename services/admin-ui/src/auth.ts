import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify<string, Buffer, number, { N: number; r: number; p: number }, Buffer>(
  scrypt,
);

const KEY_LENGTH = 32;
const COST = { N: 16384, r: 8, p: 1 };

/**
 * Hashes are written as scrypt:N:r:p:salt:hash in hex. There are no $ signs, on
 * purpose: Docker Compose would try to expand them when reading a .env file.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LENGTH, COST);
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('hex'), key.toString('hex')].join(':');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split(':');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;

  const expected = Buffer.from(hash, 'hex');
  const actual = await scryptAsync(password, Buffer.from(salt, 'hex'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(actual, expected);
}

export const SESSION_COOKIE = 'helpdesk_session';

const sign = (value: string, secret: string): string =>
  createHmac('sha256', secret).update(value).digest('base64url');

/** A session is only an expiry time with a signature, so the database holds nothing to steal. */
export function createSession(secret: string, lifetimeMs: number, now = Date.now()): string {
  const expires = String(now + lifetimeMs);
  return `${expires}.${sign(expires, secret)}`;
}

export function isValidSession(
  token: string | undefined,
  secret: string,
  now = Date.now(),
): boolean {
  if (!token) return false;

  const [expires, signature] = token.split('.');
  if (!expires || !signature) return false;

  const expected = Buffer.from(sign(expires, secret));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;

  return Number(expires) > now;
}
