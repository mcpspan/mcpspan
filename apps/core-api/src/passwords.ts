import {
  randomBytes,
  scrypt as scryptCallback,
  type ScryptOptions,
  timingSafeEqual,
} from 'node:crypto';

/**
 * scrypt with its options, as a promise.
 *
 * Written out rather than run through promisify, which picks the overload
 * without options and so hides the very parameters this file exists to set.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

/**
 * How hard each password is to hash.
 *
 * The opposite choice to the one made for API keys, and for the opposite
 * reason. A key is a long random string nobody guesses, so verification is
 * made as cheap as possible; a password is something a person chose, so
 * verification is made deliberately expensive. At these settings one attempt
 * costs around 32 MB of memory and tens of milliseconds - unnoticeable to
 * somebody signing in, ruinous to somebody working through a word list.
 *
 * scrypt rather than argon2 or bcrypt because Node has it built in. Both
 * alternatives are native modules, which means a self-hoster needs a
 * compiler, and that is a poor thing to discover halfway through an install.
 */
const COST = 2 ** 15;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/** Memory the work factor above needs: 128 * N * r, with headroom. */
const MAX_MEMORY = 128 * COST * BLOCK_SIZE * 2;

/**
 * Turns a password into something safe to store.
 *
 * The parameters travel with the hash. Raising the cost later then applies to
 * new passwords while old ones keep verifying against the settings they were
 * made with, instead of locking everybody out at once.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELISM,
    maxmem: MAX_MEMORY,
  });

  return [
    'scrypt',
    COST,
    BLOCK_SIZE,
    PARALLELISM,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * Checks a password against a stored hash.
 *
 * Returns false rather than throwing on anything it cannot read, so a row
 * corrupted by hand refuses a sign-in instead of returning a server error that
 * tells the world something is wrong with that account.
 *
 * The comparison is constant time. A byte-by-byte one leaks how much of a
 * guess was right through how long the answer took, which is enough to
 * reconstruct a hash one character at a time.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');

  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, cost, blockSize, parallelism, salt, digest] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  const expected = Buffer.from(digest, 'base64url');
  const N = Number(cost);
  const r = Number(blockSize);

  if (!Number.isInteger(N) || !Number.isInteger(r) || expected.length === 0) return false;

  try {
    const derived = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, {
      N,
      r,
      p: Number(parallelism),
      maxmem: 128 * N * r * 2,
    });

    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
