import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(time: number, len: number): string {
  let remaining = time;
  let str = '';
  for (let i = len; i > 0; i--) {
    const mod = remaining % ENCODING_LEN;
    str = ENCODING.charAt(mod) + str;
    remaining = (remaining - mod) / ENCODING_LEN;
  }
  return str;
}

function encodeRandom(len: number): string {
  const bytes = randomBytes(len);
  let str = '';
  for (let i = 0; i < len; i++) {
    str += ENCODING.charAt(bytes[i]! % ENCODING_LEN);
  }
  return str;
}

/** ULID: 48-bit ms timestamp + 80 bits of randomness, Crockford base32 encoded. */
export function ulid(seedTime: number = Date.now()): string {
  return encodeTime(seedTime, TIME_LEN) + encodeRandom(RANDOM_LEN);
}
